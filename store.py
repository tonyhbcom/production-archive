# -*- coding: utf-8 -*-
"""
production-archive · 项目归类存储

归类数据与插件本体**分开存放**，位置在 ComfyUI 的 user 目录下：

    <user>/production_archive/projects.json

这样做的好处：删除 / 重装 / 升级插件都不会丢掉你自己建立的归类。

数据模型
    projects : [{"name": "我的项目", "color": "#7ea6d8"}]
    rules    : [{"dir": "sub/dir", "project": "我的项目", "deep": true}]
               dir 是相对输出目录的路径；deep=true 表示含子目录，false 表示只含该层直属文件
    assign   : {"sub/dir/xxx_00001": "我的项目"}
               单条记录的手动指派，优先级最高

归类优先级
    手动指派  >  目录规则（目录路径更长的优先）  >  未归类（返回空串）
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading

STORE_VERSION = 1

# 数据目录名（位于 ComfyUI user 目录下）
STORE_DIRNAME = "production_archive"
# 旧版本用过的目录名，首次启动时自动迁移过来。
# 顺序 = 优先级：越靠前越新，migrate_legacy 命中第一个存在的就返回。
# 2026-09-11 改名为 production-archive 之前，用的是 prompt_archive —— 必须在列，
# 否则老用户（含本机 938 条归类）首次启动会把数据当成不存在，从零开始。
LEGACY_DIRNAMES = ("prompt_archive", "h3_prompt_archive")

# 自动分配的项目色板（建项目时轮转取色，也可由用户改用色值）
PALETTE = [
    "#7ea6d8", "#c79bd8", "#7dc8a8", "#d8b47e", "#d88f8f", "#8fb8d8",
    "#b8d88f", "#d8a8c8", "#9fb8e0", "#d8c89f", "#a8d8d0", "#d8a87e",
]

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_lock = threading.RLock()


def _name(s) -> str:
    """清洗项目名：去空白、压空格、限长。"""
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s[:60]


def _dir(s) -> str:
    """清洗目录路径：统一分隔符、去首尾斜杠。"""
    s = str(s or "").replace("\\", "/").strip()
    return s.strip("/")


# ------------------------------------------------------------ 路径与迁移

def store_dir(user_dir: str) -> str:
    return os.path.join(user_dir, STORE_DIRNAME)


def store_path(user_dir: str) -> str:
    return os.path.join(store_dir(user_dir), "projects.json")


def cache_path(user_dir: str) -> str:
    """索引缓存也放在这里：升级 / 重装插件后不用重建索引。"""
    return os.path.join(store_dir(user_dir), "index-cache.json.gz")


def migrate_legacy(user_dir: str) -> str:
    """把旧版数据目录搬到新名字下。

    只在「新目录不存在 + 旧目录存在」时执行，用复制而非移动，
    这样万一新版有问题，旧目录还完整留着可以回退。

    返回 "migrated" / "already" / "nothing" 之一。
    """
    dst = store_dir(user_dir)
    if os.path.isdir(dst):
        return "already"
    for old in LEGACY_DIRNAMES:
        src = os.path.join(user_dir, old)
        if os.path.isdir(src):
            try:
                shutil.copytree(src, dst)
                return "migrated"
            except Exception:
                return "nothing"
    return "nothing"


def normalize(raw) -> dict:
    """把任意输入（含损坏的旧文件）洗成合法结构。"""
    if not isinstance(raw, dict):
        raw = {}

    projects, seen = [], set()
    for p in (raw.get("projects") or []):
        if isinstance(p, str):
            p = {"name": p}
        if not isinstance(p, dict):
            continue
        n = _name(p.get("name"))
        if not n or n in seen:
            continue
        seen.add(n)
        c = p.get("color")
        if not isinstance(c, str) or not _HEX.match(c):
            c = PALETTE[len(projects) % len(PALETTE)]
        projects.append({"name": n, "color": c.lower()})

    rules = []
    for r in (raw.get("rules") or []):
        if not isinstance(r, dict):
            continue
        d = _dir(r.get("dir"))
        pr = _name(r.get("project"))
        if not d or pr not in seen:
            continue
        if any(x["dir"] == d and x["project"] == pr for x in rules):
            continue
        rules.append({"dir": d, "project": pr, "deep": bool(r.get("deep", True))})

    assign = {}
    for k, v in (raw.get("assign") or {}).items():
        k = _dir(k)
        v = _name(v)
        if k and v in seen:
            assign[k] = v

    return {"version": STORE_VERSION, "projects": projects,
            "rules": rules, "assign": assign}


# ------------------------------------------------------------ 读写

def load(path: str) -> dict:
    with _lock:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return normalize(json.load(f))
        except Exception:
            return normalize(None)


def save(path: str, data) -> dict:
    data = normalize(data)
    with _lock:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    return data


def exists(path: str) -> bool:
    return os.path.exists(path)


# ------------------------------------------------------------ 归类判定

def resolve(rel_dir: str, rel_key: str, data: dict):
    """返回 (项目名, 来源)；未归类时项目名为空串，来源为 "none"。"""
    a = data.get("assign") or {}
    if rel_key in a:
        return a[rel_key], "manual"

    d = _dir(rel_dir)
    best = None
    for r in (data.get("rules") or []):
        rd = r["dir"]
        hit = (d == rd or d.startswith(rd + "/")) if r.get("deep", True) else (d == rd)
        if hit and (best is None or len(rd) > len(best["dir"])):
            best = r
    if best:
        return best["project"], "rule"
    return "", "none"


# ------------------------------------------------------------ 变更操作

def add_project(data: dict, name: str) -> dict:
    name = _name(name)
    if not name:
        raise ValueError("项目名不能为空")
    if any(p["name"] == name for p in data.get("projects") or []):
        raise ValueError("项目「%s」已存在" % name)
    data.setdefault("projects", []).append(
        {"name": name, "color": PALETTE[len(data["projects"]) % len(PALETTE)]})
    return data


def rename_project(data: dict, old: str, new: str) -> dict:
    """改名并同步更新所有规则与手动指派里的引用，否则归类会丢。"""
    old, new = _name(old), _name(new)
    if not new:
        raise ValueError("新项目名不能为空")
    hit = False
    for p in data.get("projects") or []:
        if p["name"] == old:
            p["name"] = new
            hit = True
    if not hit:
        raise ValueError("项目「%s」不存在" % old)
    for r in data.get("rules") or []:
        if r["project"] == old:
            r["project"] = new
    for k, v in list((data.get("assign") or {}).items()):
        if v == old:
            data["assign"][k] = new
    return data


def del_project(data: dict, name: str) -> dict:
    """删除项目，同时摘掉它的规则与手动指派（记录本身不受影响）。"""
    name = _name(name)
    data["projects"] = [p for p in (data.get("projects") or []) if p["name"] != name]
    data["rules"] = [r for r in (data.get("rules") or []) if r["project"] != name]
    data["assign"] = {k: v for k, v in (data.get("assign") or {}).items() if v != name}
    return data


def set_color(data: dict, name: str, color: str) -> dict:
    for p in data.get("projects") or []:
        if p["name"] == _name(name):
            if _HEX.match(str(color or "")):
                p["color"] = str(color).lower()
            break
    return data


def add_rule(data: dict, rel_dir: str, project: str, deep: bool = True) -> dict:
    d, pr = _dir(rel_dir), _name(project)
    if not d:
        raise ValueError("目录不能为空")
    if pr not in {p["name"] for p in data.get("projects") or []}:
        raise ValueError("项目「%s」不存在" % pr)
    data["rules"] = [r for r in (data.get("rules") or [])
                     if not (r["dir"] == d and r["project"] == pr)]
    data["rules"].append({"dir": d, "project": pr, "deep": bool(deep)})
    return data


def del_rule(data: dict, rel_dir: str, project: str = "") -> dict:
    d, pr = _dir(rel_dir), _name(project)
    data["rules"] = [r for r in (data.get("rules") or [])
                     if not (r["dir"] == d and (not pr or r["project"] == pr))]
    return data


def assign(data: dict, keys, project: str) -> dict:
    """批量指派；project 为空串表示清除手动指派，回落到规则判定。"""
    project = _name(project)
    if project and project not in {p["name"] for p in data.get("projects") or []}:
        raise ValueError("项目「%s」不存在" % project)
    a = data.setdefault("assign", {})
    n = 0
    for k in keys or []:
        k = _dir(k)
        if not k:
            continue
        if project:
            a[k] = project
        else:
            a.pop(k, None)
        n += 1
    return data, n


def _remap_path(p: str, dirmap: dict) -> str:
    """按目录映射改写路径（最长前缀优先）。"""
    p = _dir(p)
    best = None
    for old in dirmap:
        if p == old or p.startswith(old + "/"):
            if best is None or len(old) > len(best):
                best = old
    if best is None:
        return p
    rest = p[len(best):]
    new = _dir(dirmap[best])
    return (new + rest) if new else rest.lstrip("/")


def rekey(data: dict, keymap=None, dirmap=None) -> dict:
    """文件 / 目录被移动或改名后，把 assign 与 rules 里的路径跟着改。

    不做这一步，「手动指派」就会指着一个已经不存在的路径 —— 用户看到的是归类凭空消失。

    keymap: {旧记录键: 新记录键}  —— 单条资产的移动 / 改名
    dirmap: {旧目录: 新目录}      —— 目录改名（同时改写 rules，否则目录规则整条失效）
    """
    keymap = keymap or {}
    if keymap:
        data["assign"] = {keymap.get(_dir(k), _dir(k)): v
                          for k, v in (data.get("assign") or {}).items()}
    if dirmap:
        data["assign"] = {_remap_path(k, dirmap): v
                          for k, v in (data.get("assign") or {}).items()}
        for r in (data.get("rules") or []):
            r["dir"] = _remap_path(r["dir"], dirmap)
    return data


def stats(data: dict, rows) -> dict:
    """按项目统计条数（含未归类）。"""
    cnt = {}
    for r in rows:
        e = r.get("e") or ""
        cnt[e] = cnt.get(e, 0) + 1
    return cnt
