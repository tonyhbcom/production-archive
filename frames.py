# -*- coding: utf-8 -*-
"""抽帧 —— 把视频里「你亲眼确认过的那一帧」抠出来，存成 PNG。

设计取舍（2026-10-07）

1) **不引入任何第三方依赖。** 插件对外的招牌是「不需要 pip install」，
   所以这里不 import cv2 / av / imageio，而是**探测**本机已有的 ffmpeg 可执行文件：
       ① imageio-ffmpeg 自带的那个（ComfyUI 生态里最常见 —— VHS 等一大票插件都带）
       ② 系统 PATH 里的 ffmpeg
   探测不到就**诚实地把功能关掉**（前端按钮置灰 + 一句人话），而不是崩给用户看。

2) **为什么交给 ffmpeg 抽，而不是前端 canvas。**
   canvas 只能拿到「浏览器解出来的那一帧」—— 遇上 10bit / 冷门编码直接黑屏；
   而且视频在预览窗里是缩放显示的，一不小心就抽出个缩略图尺寸。
   ffmpeg 抽的是**原始分辨率的那一帧**，0.3 秒出图，什么编码都啃得动。

3) **抽出来的帧要带上源片的元数据。**
   把源视频的 prompt / workflow 写回 PNG 的 tEXt 块 ——
   这样它在档案库里就不是孤儿：看得出它出自哪条片子、当时的提示词是什么。
   （不写的话，用户在列表里看到的就是一堆「无提示词」的灰色记录。）
"""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
import zlib

from . import engine, fsops

FRAME_DIRNAME = "抽帧"           # 抽出来的帧放输出目录下的这个子目录
_TIMEOUT = 120                   # 单帧最多等 120 秒（4K 长片精确 seek 也够）
_ff = {"exe": None, "tried": False}

# PNG 里要盖回去的元数据键：源视频里叫什么，这里就用什么
_META_KEYS = ("prompt", "workflow")


# ------------------------------------------------------------------ ffmpeg 探测

def find_ffmpeg() -> str:
    """找一把能用的 ffmpeg。找到返回绝对路径，找不到返回空串。

    结果缓存 —— 这个函数每次抽帧都会被调到，没必要反复去探测。
    """
    if _ff["tried"]:
        return _ff["exe"] or ""

    exe = ""

    # ① imageio-ffmpeg 自带的二进制（ComfyUI 里最可能有的那把）
    try:
        import imageio_ffmpeg                     # noqa: PLC0415
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.isfile(p):
            exe = p
    except Exception:
        pass

    # ② 系统 PATH
    if not exe:
        for name in ("ffmpeg", "ffmpeg.exe"):
            p = shutil.which(name)
            if p:
                exe = p
                break

    # ③ 顺着 ComfyUI 的安装位置找（整合包常把 ffmpeg 放在固定几处）
    #
    #    ⚠️ 不能拿 `__file__` 往上爬来定位 ComfyUI 根 —— 开发环境下插件是
    #    junction 软链，`abspath(__file__)` 会解析到**源码真身**（D 盘），
    #    而不是 custom_nodes 里的那个位置，于是永远找不到隔壁的 python 目录。
    #    正确的锚点是 folder_paths（ComfyUI 自己知道自己装在哪）。
    if not exe:
        roots = []
        try:
            import folder_paths                       # noqa: PLC0415
            roots.append(os.path.dirname(os.path.abspath(folder_paths.__file__)))
        except Exception:
            pass
        roots.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        seen = set()
        for r in roots:
            for up in (r, os.path.dirname(r)):
                for rel in (os.path.join("python", "Lib", "site-packages",
                                         "imageio_ffmpeg", "binaries"),
                            os.path.join("ffmpeg", "bin"),
                            os.path.join("程序文件", "ffmpeg", "bin")):
                    d = os.path.join(up, rel)
                    if d in seen or not os.path.isdir(d):
                        continue
                    seen.add(d)
                    for fn in sorted(os.listdir(d)):
                        if fn.lower().startswith("ffmpeg") and fn.lower().endswith(".exe"):
                            exe = os.path.join(d, fn)
                            break
                    if exe:
                        break
                if exe:
                    break
            if exe:
                break

    _ff["tried"] = True
    _ff["exe"] = exe
    return exe


def probe() -> dict:
    """给前端的「这功能能不能用」报告。"""
    exe = find_ffmpeg()
    if not exe:
        return {"ready": False, "exe": "", "reason":
                "没找到 ffmpeg。装上 ComfyUI-VideoHelperSuite 之类的插件会顺带带上它，"
                "或者把 ffmpeg.exe 放进系统 PATH 也行。"}
    return {"ready": True, "exe": exe, "reason": ""}


def _run_ff(cmd: list) -> subprocess.CompletedProcess:
    kw = {}
    if os.name == "nt":
        # 不弹黑框 —— 点了抽帧结果蹦出个 cmd 窗口，那就太难看了
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace",
                          timeout=_TIMEOUT, **kw)


# ------------------------------------------------------------------ PNG 元数据

def _stamp_png(png_path: str, chunks: dict) -> bool:
    """把 tEXt 块插进 PNG 的 IHDR 之后（规范要求 tEXt 必须在 IDAT 之前）。"""
    blocks = []
    for k, v in chunks.items():
        if not v:
            continue
        body = k.encode("latin-1") + b"\x00" + str(v).encode("utf-8")
        blocks.append(struct.pack(">I", len(body)) + b"tEXt" + body
                      + struct.pack(">I", zlib.crc32(b"tEXt" + body) & 0xFFFFFFFF))
    if not blocks:
        return False
    try:
        with open(png_path, "rb") as fh:
            data = fh.read()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return False
        pos = 33                                   # 8 签名 + 25（IHDR 整块）
        with open(png_path, "wb") as fh:
            fh.write(data[:pos] + b"".join(blocks) + data[pos:])
        return True
    except Exception:
        return False


def _source_meta(src: str) -> dict:
    """读出源视频里嵌的 prompt / workflow，好在抽出的帧上留个出处。"""
    try:
        meta = engine.mp4_meta(engine._read_tail(src, engine.MP4_TAIL_BYTES))
    except Exception:
        return {}
    return {k: meta.get(k, "") for k in _META_KEYS if meta.get(k)}


# ------------------------------------------------------------------ 抽帧主流程

def _timecode(t: float) -> str:
    """3.42 秒 -> ``3.420s``，直接写进文件名，方便对回片子里那一刻。"""
    ms = int(round(max(0.0, float(t)) * 1000))
    return "%d.%03ds" % (ms // 1000, ms % 1000)


def _free_path(folder: str, stem: str, ext: str) -> str:
    """同名就加 (2)，**绝不覆盖**已有的帧。"""
    p = os.path.join(folder, stem + ext)
    if not os.path.exists(p):
        return p
    for i in range(2, 1000):
        p = os.path.join(folder, "%s (%d)%s" % (stem, i, ext))
        if not os.path.exists(p):
            return p
    return p


def grab(output_dir: str, src_rel: str, t, subdir: str = "") -> dict:
    """从 ``src_rel`` 的 ``t`` 秒处抽一帧，存成 PNG。

    返回 ``{rel, dir_rel, name, abs, t, size, stamped}``；出错抛异常。
    """
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError(probe()["reason"])

    src_rel = fsops._norm(src_rel)
    if not src_rel:
        raise ValueError("没指定要抽帧的视频")
    src = fsops._abs_in(output_dir, src_rel)
    if not src or not os.path.isfile(src):
        raise ValueError("视频文件不存在：%s" % src_rel)
    if not src.lower().endswith((".mp4", ".mov", ".webm", ".mkv")):
        raise ValueError("只能对视频抽帧：%s" % src_rel)

    try:
        t = float(t)
    except (TypeError, ValueError):
        raise ValueError("时间点得是个数字（秒），例如 3.42")
    if t < 0:
        raise ValueError("时间点不能是负数")
    if t > 24 * 3600:
        raise ValueError("时间点超出合理范围（> 24 小时）")

    # 输出目录：默认 输出目录\抽帧\<视频名>\
    stem = os.path.basename(src_rel)
    for ext in (".mp4", ".mov", ".webm", ".mkv"):
        if stem.lower().endswith(ext):
            stem = stem[:-len(ext)]
            break
    if stem.endswith("-audio"):
        stem = stem[:-6]
    if not stem:
        raise ValueError("视频文件名不合法")

    rel_dir = fsops._norm(subdir) if subdir else "%s/%s" % (FRAME_DIRNAME, stem)
    dest_dir = fsops._abs_in(output_dir, rel_dir)
    if not dest_dir:
        raise ValueError("目标目录不合法（只能放在输出目录里面）")
    os.makedirs(dest_dir, exist_ok=True)

    out = _free_path(dest_dir, "%s_t%s" % (stem, _timecode(t)), ".png")

    cmd = [ff, "-y", "-ss", "%.3f" % t, "-i", src,
           "-frames:v", "1", "-compression_level", "3", out]
    try:
        r = _run_ff(cmd)
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffmpeg 超时了（超过 %d 秒），这个时间点可能太难定位" % _TIMEOUT)

    if r.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
        tail = (r.stderr or "").strip().splitlines()
        msg = tail[-1][:200] if tail else "ffmpeg 返回码 %d" % r.returncode
        if os.path.isfile(out):
            try:
                os.remove(out)
            except OSError:
                pass
        raise RuntimeError("抽帧失败：%s" % msg)

    # 把源片的提示词盖回去 —— 抽出的帧在档案库里才不是孤儿
    stamped = False
    meta = _source_meta(src)
    if meta:
        stamped = _stamp_png(out, meta)

    name = os.path.basename(out)
    return {
        "rel": "%s/%s" % (rel_dir, name),
        "dir_rel": rel_dir,
        "name": name,
        "abs": out,
        "t": round(t, 3),
        "size": os.path.getsize(out),
        "stamped": stamped,
    }
