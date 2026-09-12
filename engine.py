# -*- coding: utf-8 -*-
"""
production-archive · 扫描引擎

从 ComfyUI 输出文件的**内嵌元数据**里提取当时送进模型的完整提示词。
不依赖任何外部库，只用标准库。

数据来源：
  PNG : tEXt 块                  ->  prompt(API执行图) / workflow(前端图)
  MP4 : moov>udta>meta>ilst      ->  同两项（VHS_VideoCombine 写入）

尺寸来源（不依赖任何特定节点，任何工作流都适用）：
  PNG : IHDR 块前 24 字节
  MP4 : moov>trak>tkhd 末尾的 16.16 定点宽高

扫描策略：按 (mtime, size) 做增量缓存，只有新增/改动的文件才重新解析。
归类策略：交给 store（手动指派 > 目录规则 > 未归类）。
"""
from __future__ import annotations

import datetime
import gzip
import json
import os
import struct
import threading

from . import store

CACHE_VERSION = 4                  # 3 → 4：提示词识别策略修正，旧缓存里的错值要重扫
PNG_HEAD_BYTES = 320 * 1024        # PNG 的 tEXt 在 IDAT 之前，读头部即可
MP4_TAIL_BYTES = 1024 * 1024       # MP4 的 moov 在文件末尾
MEDIA_EXT = (".png", ".mp4")

# 读取 seed 的节点类型：不同工作流可能用其中任意一个
SEED_NODES = ("RandomNoise", "KSampler", "KSamplerAdvanced")

# --------------------------------------------------------------- 提示词识别
# 这些字段装的是文件名 / 路径 / 资源名，不是提示词。
# ⚠️ 2026-09-12 教训：旧策略是「所有字符串里取最长的那个」，被模型文件名坑死 ——
#    Krea 2 工作流里 "krea2_turbo_int8_convrot.safetensors" 36 字，
#    赢了真正的提示词 35 字，面板上就显示成一串文件名。
#    之前那套工作流的提示词几百字，所以这个坑一直到换模型才暴露。
NON_TEXT_KEYS = frozenset((
    "unet_name", "lora_name", "vae_name", "clip_name", "ckpt_name",
    "control_net_name", "model_name", "style_model_name", "gligen_name",
    "embedding_name", "filename_prefix", "filename", "file", "path",
    "directory", "image", "mask", "audio", "video", "output_path",
    "custom_path", "save_path", "output_dir",
))

# 值以这些后缀结尾 → 判定为文件名，不作为提示词
RESOURCE_EXTS = (
    ".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".gguf", ".bin", ".onnx",
    ".vae", ".yaml", ".yml", ".json", ".txt", ".csv", ".zip", ".7z", ".rar",
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
    ".mp4", ".mov", ".webm", ".mkv", ".avi", ".wav", ".mp3", ".flac",
)

# 已知的「文本载体」节点 —— 提示词优先从这些节点里找
TEXT_NODES = frozenset((
    "CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux",
    "CLIPTextEncodeSDXLRefiner", "BNK_CLIPTextEncodeAdvanced",
    "PrimitiveString", "PrimitiveStringMultiline",
    "Text", "String Literal", "Text Multiline",
    "Text Multiline (Code Compatible)", "MultilineText", "Textbox",
    "Prompt", "ttN text",
))


def _looks_like_resource(v: str) -> bool:
    """长得像文件名（以模型/媒体后缀结尾）就不是提示词。"""
    return v.strip().lower().endswith(RESOURCE_EXTS)


def _pick_prompt(api: dict, wf: dict) -> str:
    """挑出提示词。分三层，前一层拿不到才退到下一层。

    ① 文本节点里的最长串（排除文件名字段与资源后缀）
    ② 其他节点里的最长串（同样排除）—— 有些自定义节点不叫标准名
    ③ 全部字符串里最长（退到旧行为，保证不会比原来更差）
    """
    text_best = other_best = any_best = ""

    for node in api.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type", "")
        for key, v in (node.get("inputs") or {}).items():
            if not isinstance(v, str):
                continue
            v = v.strip()
            if not v:
                continue
            if len(v) > len(any_best):
                any_best = v
            if key in NON_TEXT_KEYS or _looks_like_resource(v):
                continue
            if ct in TEXT_NODES:
                if len(v) > len(text_best):
                    text_best = v
            elif len(v) > len(other_best):
                other_best = v

    # 前端图兜底：有些节点的文本只落在 widgets_values 里
    if isinstance(wf, dict):
        for node in (wf.get("nodes") or []):
            if not isinstance(node, dict) or node.get("type") not in TEXT_NODES:
                continue
            for v in (node.get("widgets_values") or []):
                if isinstance(v, str) and v.strip() and not _looks_like_resource(v):
                    if len(v.strip()) > len(text_best):
                        text_best = v.strip()

    if _looks_like_resource(any_best):
        any_best = ""          # 兜底也不能把文件名当提示词 —— 宁可显示「无」
    return text_best or other_best or any_best


# ---------------------------------------------------------------- 元数据读取

def _read_head(path: str, n: int) -> bytes:
    with open(path, "rb") as f:
        return f.read(n)


def _read_tail(path: str, n: int) -> bytes:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > n:
            f.seek(size - n)
        return f.read()


def png_meta(data: bytes) -> dict:
    """从 PNG 的 tEXt 块读出 prompt / workflow。"""
    res: dict = {}
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return res
    i, n = 8, len(data)
    while i + 8 <= n:
        try:
            length, ctype = struct.unpack(">I4s", data[i:i + 8])
        except struct.error:
            break
        if length > n - i - 12:          # 块体被读取窗口截断
            break
        if ctype == b"tEXt":
            body = data[i + 8:i + 8 + length]
            if b"\x00" in body:
                k, v = body.split(b"\x00", 1)
                try:
                    res[k.decode("latin-1")] = v.decode("utf-8", "replace")
                except Exception:
                    pass
        elif ctype == b"IEND":
            break
        i += 12 + length
    return res


def png_size(data: bytes) -> str:
    """PNG 的 IHDR 紧跟在 8 字节签名之后：宽、高各 4 字节大端。"""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return ""
    try:
        w, h = struct.unpack(">II", data[16:24])
    except struct.error:
        return ""
    return "%dx%d" % (w, h) if w and h else ""


def mp4_meta(data: bytes) -> dict:
    """从 MP4 的 moov>udta>meta>ilst 读出 prompt / workflow。"""
    res: dict = {}
    u = data.find(b"udta")
    if u < 0:
        return res
    m = data.find(b"meta", u)
    if m < 0:
        return res
    i = data.find(b"ilst", m)
    if i < 0:
        return res
    i += 4
    n = len(data)
    payloads = []
    while i + 8 <= n:
        try:
            sz = struct.unpack(">I", data[i:i + 4])[0]
        except struct.error:
            break
        if sz < 8 or i + sz > n:
            break
        item = data[i + 8:i + sz]
        d = item.find(b"data")
        if d >= 0:
            body = item[d + 12:]
            if body[:1] == b"{":
                try:
                    payloads.append(body.decode("utf-8", "replace"))
                except Exception:
                    pass
        i += sz
    for v in payloads:
        if '"links"' in v and '"extra"' in v:
            res["workflow"] = v
        elif '"class_type"' in v and "prompt" not in res:
            res["prompt"] = v
    return res


def mp4_size(data: bytes) -> str:
    """tkhd box 的最后 8 字节是宽高（16.16 定点，取整数部分）。"""
    i = data.find(b"tkhd")
    if i < 4 or i + 4 > len(data):
        return ""
    start = i - 4
    try:
        size = struct.unpack(">I", data[start:start + 4])[0]
    except struct.error:
        return ""
    if size < 16 or start + size > len(data):
        return ""
    try:
        w = struct.unpack(">I", data[start + size - 8:start + size - 4])[0] >> 16
        h = struct.unpack(">I", data[start + size - 4:start + size])[0] >> 16
    except struct.error:
        return ""
    return "%dx%d" % (w, h) if w and h else ""


# ------------------------------------------------------------------ 解析

def _parse(prompt_json: str, wf_json: str) -> dict:
    rec = {"p": "", "s": "", "r": ""}

    try:
        api = json.loads(prompt_json) if prompt_json else {}
    except Exception:
        api = {}
    try:
        wf = json.loads(wf_json) if wf_json else {}
    except Exception:
        wf = {}

    rec["p"] = _pick_prompt(api if isinstance(api, dict) else {},
                            wf if isinstance(wf, dict) else {})

    refs = []
    if isinstance(wf, dict):
        for node in (wf.get("nodes") or []):
            if not isinstance(node, dict):
                continue
            t = node.get("type", "")
            wv = node.get("widgets_values") or []
            if t == "LoadImage" and wv and isinstance(wv[0], str):
                refs.append(os.path.basename(wv[0]))
            elif t in SEED_NODES and wv and not rec["s"]:
                rec["s"] = wv[0]
    rec["r"] = " | ".join(refs)
    return rec


def extract(path: str) -> dict:
    """读取一个输出文件，返回精简记录；无元数据返回 {}。"""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png":
        try:
            head = _read_head(path, PNG_HEAD_BYTES)
        except OSError:
            return {}
        meta, size = png_meta(head), png_size(head)
    else:
        try:
            tail = _read_tail(path, MP4_TAIL_BYTES)
        except OSError:
            return {}
        meta, size = mp4_meta(tail), mp4_size(tail)

    if not meta.get("prompt"):
        return {}
    rec = _parse(meta.get("prompt", ""), meta.get("workflow", ""))
    rec["z"] = size
    return rec


# ------------------------------------------------------------- 扫描 + 缓存

def _cache_read(path: str):
    """缓存是 gzip 压缩的 JSON（提示词重复度高，压缩后体积约为 1/4）。"""
    for opener in (lambda: gzip.open(path, "rt", encoding="utf-8"),
                   lambda: open(path, "r", encoding="utf-8")):
        try:
            with opener() as f:
                return json.load(f)
        except Exception:
            continue
    return None


def _cache_write(path: str, obj) -> None:
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = path + ".tmp"
        with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        pass


def scan(output_dir: str, cache_path: str, force: bool = False,
         store_data: dict = None) -> dict:
    """扫描输出目录，返回 {rows, stats, dirs}。增量：只有新增/改动文件才解析。

    store_data 为 store 的归类数据；为空时全部记为空串（前端显示「未归类」）。
    """
    cache = {}
    if not force and os.path.exists(cache_path):
        raw = _cache_read(cache_path)
        if raw and raw.get("version") == CACHE_VERSION:
            cache = raw.get("files") or {}

    entries: dict = {}          # rel -> {"m":mtime,"n":size,"d":数据或None}
    parsed = reused = failed = 0

    for root, _dirs, files in os.walk(output_dir):
        for fn in files:
            if os.path.splitext(fn)[1].lower() not in MEDIA_EXT:
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, output_dir).replace("\\", "/")
            try:
                st = os.stat(full)
            except OSError:
                continue
            mtime, size = int(st.st_mtime), st.st_size
            old = cache.get(rel)
            if (not force) and old and old.get("m") == mtime and old.get("n") == size:
                entries[rel] = old
                reused += 1
                continue
            try:
                d = extract(full)
            except Exception:
                d = {}
                failed += 1
            entries[rel] = {"m": mtime, "n": size, "d": d or None}
            parsed += 1

    # 只在索引确实发生变化时写盘（增量 0 解析且文件集合未变则跳过）
    if parsed or set(entries) != set(cache):
        _cache_write(cache_path, {"version": CACHE_VERSION, "files": entries})

    # 归并同一次生成的 png / mp4 / -audio.mp4
    groups: dict = {}
    for rel, e in entries.items():
        d = e.get("d")
        if not d:
            continue
        dirn, fn = os.path.split(rel)
        stem, ext = os.path.splitext(fn)
        if stem.endswith("-audio"):
            stem = stem[:-6]
        key = (dirn, stem)
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "p": "", "s": "", "z": "", "r": "", "kinds": set(),
                "t": e["m"], "mb": 0, "mp4_size": 0, "audio": False,
            }
        g["kinds"].add(ext[1:])
        g["t"] = min(g["t"], e["m"])
        if len(d.get("p", "")) > len(g["p"]):
            g["p"] = d.get("p", "")
            g["s"] = d.get("s", "")
            g["z"] = d.get("z", "")
            g["r"] = d.get("r", "")
        elif not g["z"] and d.get("z"):
            g["z"] = d.get("z")
        if ext == ".mp4":
            if fn.endswith("-audio.mp4"):
                g["mb"] = max(g["mb"], e["n"] / 1048576.0)
                g["audio"] = True
            else:
                g["mp4_size"] = max(g["mp4_size"], e["n"])

    store_data = store_data or {}
    rows = []
    dirs: dict = {}
    for (dirn, stem), g in groups.items():
        dk = "" if dirn in ("", ".") else dirn
        dirs[dk] = dirs.get(dk, 0) + 1
        disp = ("%s/%s" % (dirn, stem)).lstrip("./") if dk else stem
        ep, src = store.resolve(dirn, disp, store_data)
        rows.append({
            "f": disp,
            "d": dk,
            "e": ep,
            "as": src,                      # manual / rule / none
            "t": datetime.datetime.fromtimestamp(g["t"]).strftime("%Y-%m-%d %H:%M:%S"),
            "p": g["p"],
            "n": len(g["p"]),
            "s": str(g["s"] or ""),
            "z": g["z"],
            "r": g["r"],
            "rc": len([x for x in g["r"].split(" | ") if x]),
            "m": round(g["mp4_size"] / 1048576.0, 1) if g["mp4_size"] else 0,
            "k": ",".join(sorted(g["kinds"])),
            "a": 1 if g["audio"] else 0,      # 有带音轨的 -audio.mp4，预览时优先用它
        })
    rows.sort(key=lambda x: x["t"], reverse=True)

    stats = {
        "files": len(entries),
        "records": len(rows),
        "parsed": parsed,
        "reused": reused,
        "failed": failed,
        "with_prompt": sum(1 for r in rows if r["n"] > 0),
    }
    return {"rows": rows, "stats": stats, "dirs": dirs}


# ------------------------------------------------------- 进程内缓存 + 锁

_lock = threading.RLock()
_mem: dict = {"data": None, "at": 0.0}


def get_archive(output_dir: str, cache_file: str, store_file: str = "",
                full: bool = False, bypass_mem: bool = False) -> dict:
    """三级扫描入口（线程安全）：
      默认      —— 命中 30 秒内存缓存，秒开
      bypass_mem —— 跳过内存缓存，走磁盘缓存做增量（0.1~0.4 秒）
      full       —— 忽略磁盘缓存，全量重解析
    """
    import time
    now = time.time()
    with _lock:
        if (not full) and (not bypass_mem) and _mem["data"] is not None \
                and (now - _mem["at"]) < 30:
            return _mem["data"]
        store_data = store.load(store_file) if store_file else {}
        data = scan(output_dir, cache_file, force=full, store_data=store_data)
        _mem["data"] = data
        _mem["at"] = time.time()
    return data


def invalidate() -> None:
    """归类被修改后调用：让下一次请求重新计算（磁盘缓存仍然有效，很快）。"""
    with _lock:
        _mem["data"] = None
        _mem["at"] = 0.0


# ------------------------------------------------------- 首次运行的引导

_boot_done = False


def ensure_store(output_dir: str, cache_file: str, store_file: str) -> dict:
    """首次运行时，按**实际存在的输出子目录**建立初始项目。

    只取第一层目录，避免深目录炸出一堆项目；项目名直接用目录名，
    用户可随时在界面上改名、拆细或删除。这里不做任何业务预设。

    只在存储文件不存在时执行一次；之后一切以存储文件为准。
    """
    global _boot_done
    with _lock:
        if not _boot_done and store_file and not store.exists(store_file):
            st = store.normalize(None)
            res = scan(output_dir, cache_file, force=False, store_data={})
            tops = []
            for d in sorted(res.get("dirs") or {}):
                if not d:
                    continue
                top = d.split("/")[0]
                if top not in tops:
                    tops.append(top)
            for top in tops:
                try:
                    store.add_project(st, top)
                except ValueError:
                    pass
                store.add_rule(st, top, top, deep=True)
            store.save(store_file, st)
        _boot_done = True
        return store.load(store_file) if store_file else {}
