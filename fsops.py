# -*- coding: utf-8 -*-
r"""
production-archive · 文件操作

2026-09-11 新增。此前这个插件是**纯只读**的；从这一版起它会动文件，但只在你主动点击时：

  · 删除 = 移到 `<user>/production_archive/_trash/`（软删除，可恢复、可彻底清空）
  · 移动 / 改名的目标一律限制在**输出目录之内**，复用与只读接口同一套穿越防护
  · 一条「资产」= 同主干的 `.png` + `.mp4` + `-audio.mp4`，**永远整组一起动**
    （只动一个，档案会散架）

不做的事：
  · 不碰输出目录以外的任何路径
  · 不覆盖已存在的文件 —— 目标同名时自动加 " (2)"、" (3)"
  · 删除时不清理 store 里的归类指派 —— 留着它，将来「恢复」才能自动接回原来的项目
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time

TRASH_DIRNAME = "_trash"

# Windows 文件名非法字符
_BAD_NAME = re.compile(r'[\\/:*?"<>|]')


# ------------------------------------------------------------------ 基础

def _norm(rel) -> str:
    """统一分隔符、去首尾斜杠。"""
    return str(rel or "").replace("\\", "/").strip().strip("/")


def _abs_in(root: str, rel: str):
    """把相对路径安全地拼到根下；越界返回 None。规则与 __init__._safe_join 一致。"""
    rel = _norm(rel)
    if not rel or ".." in rel.split("/") or ":" in rel:
        return None
    root_r = os.path.realpath(root)
    p = os.path.realpath(os.path.join(root_r, rel.replace("/", os.sep)))
    if p != root_r and not p.startswith(root_r + os.sep):
        return None
    return p


def _group_names(stem: str):
    """一条资产的三个可能文件。"""
    return ["%s.png" % stem, "%s.mp4" % stem, "%s-audio.mp4" % stem]


def _free_stem(folder: str, stem: str) -> str:
    """目标目录里已有同名组时，返回一个不冲突的主干（加 " (2)" 这样）。"""
    def taken(s):
        return any(os.path.exists(os.path.join(folder, n)) for n in _group_names(s))

    if not taken(stem):
        return stem
    for i in range(2, 1000):
        s = "%s (%d)" % (stem, i)
        if not taken(s):
            return s
    return stem


def _check_name(name: str, what: str = "名字"):
    name = str(name or "").strip()
    if not name:
        raise ValueError("%s不能为空" % what)
    if "/" in name or "\\" in name:
        raise ValueError("%s里不能带路径分隔符" % what)
    if _BAD_NAME.search(name):
        raise ValueError('%s里不能出现这些字符：\\ / : * ? " < > |' % what)
    if name in (".", ".."):
        raise ValueError("%s不合法" % what)
    return name


def group_files(output_dir: str, rel_key: str):
    """给定记录键（'目录/主干' 或 '主干'），返回该组**真实存在**的文件相对路径。"""
    key = _norm(rel_key)
    if not key:
        return []
    d, stem = os.path.split(key)
    out = []
    for name in _group_names(stem):
        rel = ("%s/%s" % (d, name)) if d else name
        p = _abs_in(output_dir, rel)
        if p and os.path.isfile(p):
            out.append(rel)
    return out


def _relocate(output_dir: str, rel_key: str, dest_dir_rel: str, dest_stem: str):
    """把一条资产的文件搬到 (dest_dir_rel, dest_stem)。返回实际移动的文件数。"""
    d, stem = os.path.split(_norm(rel_key))
    dest = _abs_in(output_dir, dest_dir_rel) if _norm(dest_dir_rel) \
        else os.path.realpath(output_dir)
    if not dest:
        raise ValueError("目标目录不合法")
    os.makedirs(dest, exist_ok=True)
    n = 0
    for rel in group_files(output_dir, rel_key):
        src = _abs_in(output_dir, rel)
        name = os.path.basename(rel)
        suffix = name[len(stem):]              # .png / .mp4 / -audio.mp4
        dst = os.path.join(dest, dest_stem + suffix)
        if os.path.exists(dst):
            raise ValueError("目标已存在：%s" % os.path.basename(dst))
        shutil.move(src, dst)
        n += 1
    return n


# ------------------------------------------------------------------ 移动

def move(output_dir: str, keys, target_dir: str) -> dict:
    """把资产移到输出了目录 target_dir（空串 = 输出根目录）。"""
    target = _norm(target_dir)
    if target:
        tp = _abs_in(output_dir, target)
        if not tp:
            raise ValueError("目标目录不合法")
    moved, remap, skipped = 0, {}, []
    for key in keys or []:
        key = _norm(key)
        files = group_files(output_dir, key)
        if not files:
            skipped.append(key)
            continue
        d, stem = os.path.split(key)
        if _norm(d) == target:
            skipped.append(key)               # 已经在那儿了
            continue
        if target:
            tdir = _abs_in(output_dir, target)
        else:
            tdir = os.path.realpath(output_dir)
        free = _free_stem(tdir, stem)
        moved += _relocate(output_dir, key, target, free)
        remap[key] = ("%s/%s" % (target, free)) if target else free
    return {"moved": moved, "remap": remap, "skipped": skipped}


# ------------------------------------------------------------------ 改名

def rename(output_dir: str, key: str, new_stem: str) -> dict:
    """改资产名（同主干整组一起改）。"""
    key = _norm(key)
    if not key:
        raise ValueError("缺少资产标识")
    new_stem = _check_name(new_stem, "资产名")
    if not group_files(output_dir, key):
        raise ValueError("没找到对应的文件，可能已被移动或删除")
    d = os.path.split(key)[0]
    folder = _abs_in(output_dir, d) if d else os.path.realpath(output_dir)
    free = _free_stem(folder, new_stem)
    n = _relocate(output_dir, key, d, free)
    new_key = ("%s/%s" % (d, free)) if d else free
    return {"renamed": n, "key": new_key, "remap": {key: new_key}}


def rename_dir(output_dir: str, old_dir: str, new_name: str) -> dict:
    """改目录名（含子目录整体搬）。只能在输出目录内部改，且不能改输出根。"""
    old = _norm(old_dir)
    if not old:
        raise ValueError("输出根目录不能改名")
    new_name = _check_name(new_name, "目录名")
    src = _abs_in(output_dir, old)
    if not src or not os.path.isdir(src):
        raise ValueError("目录不存在")
    parent = os.path.dirname(old)
    new = ("%s/%s" % (parent, new_name)) if parent else new_name
    dst = _abs_in(output_dir, new)
    if not dst:
        raise ValueError("目标不合法")
    if os.path.exists(dst):
        raise ValueError("已经有一个同名目录了")
    os.rename(src, dst)
    return {"renamed": 1, "dir": new, "dirmap": {old: new}}


# ------------------------------------------------------------------ 回收站

def _trash_batch(trash_root: str, batch: str):
    return os.path.join(trash_root, batch)


def _read_manifest(bdir: str):
    mf = os.path.join(bdir, "manifest.json")
    if not os.path.isfile(mf):
        return None
    try:
        with open(mf, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_manifest(bdir: str, m: dict):
    with open(os.path.join(bdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


def trash(output_dir: str, trash_root: str, keys, probe=None) -> dict:
    """把资产移进回收站。文件放 <trash>/<批次>/files/<原相对路径>，不会互相覆盖。

    probe: 可选回调 probe(绝对路径) -> 元数据 dict。在文件搬走**之前**调一次，
           把提示词字数记进 manifest —— 这样回收站里能显示
           「提示词 1892 字，恢复后回来」，用户不会以为提示词被删没了。
    """
    batch = time.strftime("%Y%m%d-%H%M%S")
    bdir = _trash_batch(trash_root, batch)
    fdir = os.path.join(bdir, "files")
    items = []
    for key in keys or []:
        key = _norm(key)
        files = group_files(output_dir, key)
        if not files:
            continue
        rec = {"key": key, "files": [], "plen": 0}
        for rel in files:
            src = _abs_in(output_dir, rel)
            if probe and not rec["plen"]:
                try:
                    rec["plen"] = len((probe(src) or {}).get("p") or "")
                except Exception:
                    pass
            saved = rel                     # 统一用正斜杠存，跨平台都可读
            dst = os.path.join(fdir, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            rec["files"].append({
                "orig": rel,
                "saved": saved,
                "size": os.path.getsize(dst),
            })
        items.append(rec)
    if not items:
        return {"trashed": 0, "batch": "", "keys": []}
    os.makedirs(bdir, exist_ok=True)
    _write_manifest(bdir, {
        "batch": batch,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "items": items,
    })
    return {"trashed": len(items), "batch": batch, "keys": [i["key"] for i in items]}


def trash_list(trash_root: str) -> dict:
    """回收站清单（新的在前）。"""
    items, total = [], 0
    if os.path.isdir(trash_root):
        for batch in sorted(os.listdir(trash_root), reverse=True):
            bdir = _trash_batch(trash_root, batch)
            if not os.path.isdir(bdir):
                continue
            m = _read_manifest(bdir)
            if not m:
                continue
            for i, it in enumerate(m.get("items") or []):
                size = sum(f.get("size", 0) for f in (it.get("files") or []))
                total += size
                kinds = sorted({os.path.splitext(f.get("orig", ""))[1].lstrip(".")
                                for f in (it.get("files") or [])})
                key = it.get("key", "")
                items.append({
                    "id": "%s/%d" % (batch, i),
                    "batch": batch,
                    "at": m.get("at", ""),
                    "key": key,
                    "name": os.path.basename(key),
                    "dir": os.path.dirname(key),
                    "n": len(it.get("files") or []),
                    "mb": round(size / 1048576.0, 1),
                    "k": ",".join(k for k in kinds if k),
                    "plen": it.get("plen", 0),      # 提示词字数（恢复后原样回来）
                })
    return {"items": items, "mb": round(total / 1048576.0, 1),
            "dir": trash_root}


def open_dir(path: str) -> dict:
    """在系统文件管理器里打开目录。

    2026-09-11 加这颗按钮的由来：删除做的是 shutil.move（不是 Shell 删除 API），
    Windows 对「移动」的处理就是换了个文件夹 —— 所以**系统回收站里永远不会有它**。
    用户按字面去 Windows 回收站找，找不到就以为文件被真删了。
    按钮一按，文件管理器直接弹出来，亲眼看见比解释一百句管用。
    """
    path = str(path or "")
    if not os.path.isdir(path):
        return {"opened": False, "path": path, "error": "目录不存在"}
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)                          # noqa: S606 (Windows 专用)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        return {"opened": False, "path": path,
                "error": "%s: %s" % (type(e).__name__, e)}
    return {"opened": True, "path": path}


def _locate(trash_root: str, item_id: str):
    """把 '批次/序号' 解析成 (批次目录, manifest, 序号)。"""
    batch, _, idx = str(item_id or "").partition("/")
    if not batch or not idx.isdigit():
        return None, None, -1
    bdir = _trash_batch(trash_root, batch)
    m = _read_manifest(bdir)
    if not m:
        return None, None, -1
    i = int(idx)
    if i < 0 or i >= len(m.get("items") or []):
        return None, None, -1
    return bdir, m, i


def restore(trash_root: str, output_dir: str, ids, target_dir: str = "") -> dict:
    """从回收站恢复到原位（或指定目录）。目标重名时自动加 " (2)"，绝不覆盖。"""
    restored, files, renamed = 0, 0, 0
    for item_id in ids or []:
        bdir, m, i = _locate(trash_root, item_id)
        if not bdir:
            continue
        it = m["items"][i]
        key = it.get("key", "")
        orig_dir = os.path.dirname(key)
        stem = os.path.basename(key)
        dest_rel = _norm(target_dir) if _norm(target_dir) else orig_dir
        dest = _abs_in(output_dir, dest_rel) if dest_rel else os.path.realpath(output_dir)
        if not dest:
            continue
        os.makedirs(dest, exist_ok=True)
        free = _free_stem(dest, stem)
        if free != stem:
            renamed += 1
        for f in it.get("files") or []:
            src = os.path.join(bdir, "files", f.get("saved", ""))
            if not os.path.isfile(src):
                continue
            name = os.path.basename(f.get("orig", ""))
            suffix = name[len(stem):] if name.startswith(stem) else os.path.splitext(name)[1]
            dst = os.path.join(dest, free + suffix)
            if os.path.exists(dst):
                continue
            shutil.move(src, dst)
            files += 1
        restored += 1
        del m["items"][i]
        _write_manifest(bdir, m)
        _cleanup_batch(bdir, m)
    return {"restored": restored, "files": files, "renamed": renamed}


def purge(trash_root: str, ids) -> dict:
    """彻底删除指定条目（不可恢复）。"""
    deleted, files = 0, 0
    for item_id in ids or []:
        bdir, m, i = _locate(trash_root, item_id)
        if not bdir:
            continue
        it = m["items"][i]
        for f in it.get("files") or []:
            p = os.path.join(bdir, "files", f.get("saved", ""))
            try:
                if os.path.isfile(p):
                    os.remove(p)
                    files += 1
            except OSError:
                pass
        deleted += 1
        del m["items"][i]
        _write_manifest(bdir, m)
        _cleanup_batch(bdir, m)
    return {"deleted": deleted, "files": files}


def empty_trash(trash_root: str) -> dict:
    """清空回收站。"""
    n = 0
    if os.path.isdir(trash_root):
        for batch in os.listdir(trash_root):
            p = _trash_batch(trash_root, batch)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
                n += 1
    return {"cleared": n}


def _cleanup_batch(bdir: str, m: dict):
    """批次里没条目了就整批删掉。"""
    if m.get("items"):
        return
    shutil.rmtree(bdir, ignore_errors=True)
