# -*- coding: utf-8 -*-
"""
production-archive

把 ComfyUI 输出目录里每个 PNG / MP4 内嵌的提示词元数据汇总成一个档案，
在左侧栏开一个「制作档案」面板，随时搜索、查看、预览、整理历史作品。

· 不占显存、不进执行图、不影响出图
· 增量扫描：只有新增 / 改动的文件才会被重新解析
· 归类数据独立存放（ComfyUI user 目录），升级重装都不丢
· 无第三方依赖，只用标准库

关于「动不动你的文件」（v1.1.0 起）：
  浏览、搜索、筛选、预览、归类 —— 全部只读，绝不动文件。
  只有你**主动点了**「改名 / 移动 / 删除」才会写盘，而且：
    · 删除是**软删除** —— 文件被移进 user 目录下的回收站，随时能恢复，绝不真删
    · 改名 / 移动永远整组一起（.png + .mp4 + -audio.mp4），不会把档案拆散
    · 一律限制在输出目录之内，且绝不覆盖任何已存在的文件
"""
import asyncio
import functools
import os

import server
from aiohttp import web

from . import engine, fsops, store

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

__version__ = "1.1.0"

# 面板里展示的「本次更新」——发新版时同步更新
RELEASE_NOTES = [
    "列表里每条作品现在带小预览图，一眼看出是哪个镜头",
    "预览窗放大后可以用鼠标拖着看细节了（按住画面往任意方向拉）",
    "新增：改名 / 移动到别的目录 —— 同一次生成的图、视频、音轨永远整组一起动",
    "新增：删除。删掉的东西进回收站，随时能恢复，绝不真删你的文件",
    "新增：目录改名，目录规则会跟着自动更新，归类不会丢",
]

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
routes = server.PromptServer.instance.routes


# --------------------------------------------------------------- 路径

def _output_dir() -> str:
    try:
        import folder_paths
        return folder_paths.get_output_directory()
    except Exception:
        return os.path.join(os.path.dirname(os.path.dirname(PKG_DIR)), "output")


def _user_dir() -> str:
    try:
        import folder_paths
        return folder_paths.get_user_directory()
    except Exception:
        return os.path.join(os.path.dirname(os.path.dirname(PKG_DIR)), "user")


_boot_ready = False


def _ensure_boot() -> str:
    """幂等的一次性启动动作：把旧版数据目录迁移到新名字下。

    只在「新目录不存在 + 旧目录存在」时真正动手，之后只做标志位检查。
    """
    global _boot_ready
    if _boot_ready:
        return "already"
    status = store.migrate_legacy(_user_dir())
    _boot_ready = True
    return status


def _store_file() -> str:
    _ensure_boot()
    return store.store_path(_user_dir())


def _cache_file() -> str:
    _ensure_boot()
    return store.cache_path(_user_dir())


def _safe_join(root: str, rel: str):
    """把相对路径安全地拼到根目录下，挡掉目录穿越。"""
    rel = str(rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/") or ":" in rel:
        return None
    root_r = os.path.realpath(root)
    p = os.path.realpath(os.path.join(root_r, rel.replace("/", os.sep)))
    if p != root_r and not p.startswith(root_r + os.sep):
        return None
    return p


async def _run(func, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(func, *args))


async def _mutate(fn):
    """在后台线程里「读存储 -> 变换 -> 写回」，返回 (存储, fn 的返回值)。"""
    def job():
        p = _store_file()
        d = store.load(p)
        extra = fn(d)
        store.save(p, d)
        return d, extra
    return await _run(job)


# ------------------------------------------------------------------ 列表

@routes.get("/productionarchive/list")
async def pa_list(request):
    """返回全部档案记录。

    refresh=1 -> 跳过内存缓存，走磁盘缓存做增量（有新作品时用这个）
    full=1    -> 忽略磁盘缓存，全量重解析（索引异常时才用）
    """
    q = request.query
    truthy = ("1", "true", "yes")
    refresh = str(q.get("refresh", "")).lower() in truthy
    full = str(q.get("full", "")).lower() in truthy
    out, cf, sf = _output_dir(), _cache_file(), _store_file()
    try:
        await _run(engine.ensure_store, out, cf, sf)
        data = await _run(engine.get_archive, out, cf, sf, full, refresh)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)
    return web.json_response({
        "ok": True,
        "version": __version__,
        "notes": RELEASE_NOTES,
        "output_dir": out,
        "stats": data["stats"],
        "dirs": data.get("dirs") or {},
        "rows": data["rows"],
    })


# --------------------------------------------------------------- 项目管理

@routes.get("/productionarchive/projects")
async def pa_projects_get(request):
    sp = _store_file()
    data = await _run(store.load, sp)
    return web.json_response({"ok": True, "store": data, "store_path": sp})


@routes.post("/productionarchive/projects")
async def pa_projects_post(request):
    """项目 / 规则 / 指派 的一切写操作都走这里。

    body: {"action": "...", ...}
      add      {name}                    新增项目
      rename   {old, new}                重命名（同步更新规则与指派引用）
      del      {name}                    删除项目（连带清理规则与指派）
      color    {name, color}             改项目颜色
      rule_add {dir, project, deep}      加目录规则
      rule_del {dir, project}            删目录规则
      save     {store}                   整体替换（高级用法）
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    act = str(body.get("action") or "").strip()

    def job(d):
        if act == "add":
            store.add_project(d, body.get("name"))
        elif act == "rename":
            store.rename_project(d, body.get("old"), body.get("new"))
        elif act == "del":
            store.del_project(d, body.get("name"))
        elif act == "color":
            store.set_color(d, body.get("name"), body.get("color"))
        elif act == "rule_add":
            store.add_rule(d, body.get("dir"), body.get("project"),
                           bool(body.get("deep", True)))
        elif act == "rule_del":
            store.del_rule(d, body.get("dir"), body.get("project") or "")
        elif act == "save":
            return store.normalize(body.get("store"))
        else:
            raise ValueError("未知操作：%s" % (act or "(空)"))
        return None

    try:
        data, replaced = await _mutate(job)
        if replaced is not None:
            data = await _run(store.save, _store_file(), replaced)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)

    engine.invalidate()
    return web.json_response({"ok": True, "store": data})


# --------------------------------------------------------------- 批量指派

@routes.post("/productionarchive/assign")
async def pa_assign(request):
    """把一个或多个作品归类到某项目；project 为空则清除指派（回落到目录规则）。

    body: {"keys": ["sub/dir/name", ...], "project": "项目名"}
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    keys = body.get("keys") or []
    if isinstance(keys, str):
        keys = [keys]
    project = str(body.get("project") or "")

    def job(d):
        return store.assign(d, keys, project)[1]

    try:
        data, n = await _mutate(job)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)

    engine.invalidate()
    return web.json_response({"ok": True, "count": n, "store": data})


# --------------------------------------------------------------- 媒体文件

@routes.get("/productionarchive/file")
async def pa_file(request):
    """把输出目录里的图片 / 视频喂给前端预览。路径被限制在输出目录内。"""
    p = _safe_join(_output_dir(), request.query.get("f", ""))
    if not p:
        return web.Response(status=400, text="invalid path")
    if not os.path.isfile(p):
        return web.Response(status=404, text="not found")
    try:
        return web.FileResponse(p)
    except Exception as e:
        return web.Response(status=500, text="%s" % e)


@routes.get("/productionarchive/reveal")
async def pa_reveal(request):
    """返回某条记录对应的原始文件绝对路径，便于复制或外部工具定位。"""
    name = request.query.get("f", "")
    if not name:
        return web.json_response({"ok": False, "error": "缺少参数 f"}, status=400)
    out = _output_dir()
    stem = name[:-6] if name.endswith("-audio") else name
    found = []
    for c in ("%s.png" % stem, "%s.mp4" % stem, "%s-audio.mp4" % stem):
        p = _safe_join(out, c)
        if p and os.path.exists(p):
            found.append(p)
    return web.json_response({"ok": True, "paths": found})


# ------------------------------------------- 文件操作（会动文件，v1.1.0 新增）

def _trash_root() -> str:
    """回收站放在 user 目录下 —— 和归类数据同一层，升级重装都不丢。"""
    return os.path.join(store.store_dir(_user_dir()), fsops.TRASH_DIRNAME)


def _keys_of(body) -> list:
    k = body.get("keys")
    if isinstance(k, str):
        return [k]
    if k:
        return list(k)
    one = body.get("key")
    return [one] if one else []


async def _rekey(keymap=None, dirmap=None):
    """文件被移动 / 改名后，把 store 里的手动指派与目录规则跟着改。

    漏掉这一步，「手动指派」就会指着一个已不存在的路径 —— 用户看到的是归类凭空消失。
    """
    if not keymap and not dirmap:
        return

    def job(d):
        store.rekey(d, keymap=keymap, dirmap=dirmap)

    await _mutate(job)


@routes.post("/productionarchive/asset")
async def pa_asset(request):
    """资产级写操作。全部限制在输出目录之内，且绝不覆盖已存在的文件。

    body:
      {"action":"trash",  "keys":[...]}                    删除 → 回收站（软删除）
      {"action":"move",   "keys":[...], "target":"子目录"}  移动到目录（空串 = 输出根）
      {"action":"rename", "key":"目录/主干", "name":"新名"}  改名（同主干整组一起）
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    act = str(body.get("action") or "").strip()
    out = _output_dir()
    try:
        if act == "trash":
            # 把 engine.extract 传进去：在文件搬走**之前**记下提示词字数，
            # 回收站里就能显示「提示词 1892 字」，用户才不会以为提示词被删没了
            res = await _run(fsops.trash, out, _trash_root(), _keys_of(body),
                             engine.extract)
            # 故意不清理 assign：留着它，将来「恢复」才能自动接回原来的项目
        elif act == "move":
            res = await _run(fsops.move, out, _keys_of(body), body.get("target") or "")
            await _rekey(keymap=res.get("remap"))
        elif act == "rename":
            res = await _run(fsops.rename, out, body.get("key"), body.get("name"))
            await _rekey(keymap=res.get("remap"))
        else:
            raise ValueError("未知操作：%s" % (act or "(空)"))
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)
    engine.invalidate()
    return web.json_response({"ok": True, "result": res})


@routes.post("/productionarchive/dir")
async def pa_dir(request):
    """目录级写操作：改名。只能在输出目录内部改，且不能改输出根。

    body: {"action":"rename", "dir":"renders/take01", "name":"take02"}
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    act = str(body.get("action") or "").strip()
    try:
        if act == "rename":
            res = await _run(fsops.rename_dir, _output_dir(),
                             body.get("dir"), body.get("name"))
            await _rekey(dirmap=res.get("dirmap"))
        else:
            raise ValueError("未知操作：%s" % (act or "(空)"))
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)
    engine.invalidate()
    return web.json_response({"ok": True, "result": res})


@routes.get("/productionarchive/trash")
async def pa_trash_get(request):
    """回收站清单。"""
    try:
        data = await _run(fsops.trash_list, _trash_root())
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)
    return web.json_response({"ok": True, "data": data})


@routes.post("/productionarchive/trash")
async def pa_trash_post(request):
    """回收站操作。

    body:
      {"action":"restore", "ids":[...], "target":""}   恢复（空 target = 回原位）
      {"action":"purge",   "ids":[...]}                彻底删除，不可恢复
      {"action":"empty"}                               清空回收站
      {"action":"open"}                                在文件管理器里打开回收站目录
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    act = str(body.get("action") or "").strip()
    ids = body.get("ids") or []
    if isinstance(ids, str):
        ids = [ids]
    try:
        if act == "restore":
            res = await _run(fsops.restore, _trash_root(), _output_dir(),
                             ids, body.get("target") or "")
        elif act == "purge":
            res = await _run(fsops.purge, _trash_root(), ids)
        elif act == "empty":
            res = await _run(fsops.empty_trash, _trash_root())
        elif act == "open":
            res = await _run(fsops.open_dir, _trash_root())
        else:
            raise ValueError("未知操作：%s" % (act or "(空)"))
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response(
            {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, status=500)
    engine.invalidate()
    return web.json_response({"ok": True, "result": res})


print("\033[92m[production-archive]\033[0m v%s 已加载：左侧栏新增「\033[93m制作档案\033[0m」面板"
      % __version__)
