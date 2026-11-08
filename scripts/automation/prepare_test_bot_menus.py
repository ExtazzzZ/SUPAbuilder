"""Подготовка двух тестовых меню из окружения backend; публикация только с --publish.

Запускать из /app/backend с PYTHONPATH=/app/backend. Секреты берутся из settings.
По умолчанию выполняются только GET и не сохраняющий изменения POST validate.
При потере ответа publish автоматически не повторяется: сверить GET с сохранённым graph.
"""

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

BOT_IDS = ("8764154714", "9002621157")


def menu_spec(greeting, check_reply):
    return {
        "formatVersion": 1,
        "name": "Тестовое меню CRM",
        "channel": "api",
        "steps": [{
            "type": "send", "id": "main", "text": greeting,
            "buttons": [
                {"text": "Проверить кнопку", "then": [{
                    "type": "send", "id": "check", "text": check_reply,
                    "buttons": [{"text": "Назад", "then": [{"type": "goto", "targetId": "main"}]}],
                }]},
                {"text": "Открыть меню", "then": [{
                    "type": "send", "id": "screen2", "text": "Экран 2. Выберите действие:",
                    "buttons": [
                        {"text": "Назад", "then": [{"type": "goto", "targetId": "main"}]},
                        {"text": "Далее", "then": [{
                            "type": "send", "id": "screen3", "text": "Экран 3. Завершение раздела.",
                            "buttons": [
                                {"text": "Назад", "then": [{"type": "goto", "targetId": "screen2"}]},
                                {"text": "В главное меню", "then": [{"type": "goto", "targetId": "main"}]},
                            ],
                        }]},
                    ],
                }]},
            ],
        }],
    }



def text_steps(value):
    if isinstance(value, dict):
        if value.get("stepType") == "sendText" and isinstance(value.get("text"), str):
            yield value["text"]
        for child in value.values():
            yield from text_steps(child)
    elif isinstance(value, list):
        for child in value:
            yield from text_steps(child)


def preserved_texts(graph):
    starts = [node for node in graph["nodes"] if node["data"].get("isStartNode")]
    if len(starts) != 1:
        raise RuntimeError("Не найден единственный начальный блок")
    greetings = list(text_steps(starts[0]))
    answers = {text for text in text_steps(graph["nodes"]) if text.startswith("Кнопка работает")}
    if not greetings or len(answers) != 1:
        raise RuntimeError("Не удалось сохранить прежнее приветствие и ответ кнопки")
    return greetings[0], answers.pop()


def apply_menu_names(graph, greeting, check_reply):
    # Привязка к содержимому шага, затем к id блока: порядок компилятора не значим.
    names = {
        greeting: "Главное меню", check_reply: "Проверка кнопки",
        "Экран 2. Выберите действие:": "Экран 2",
        "Экран 3. Завершение раздела.": "Экран 3",
    }
    node_names = {}
    for node in graph["nodes"]:
        texts = list(text_steps(node["data"]["details"]["steps"]))
        if len(texts) != 1 or texts[0] not in names:
            raise RuntimeError("Неожиданный блок скомпилированного меню")
        node_names[node["id"]] = names[texts[0]]
    if len(node_names) != 4 or len(set(node_names.values())) != 4:
        raise RuntimeError("Меню должно содержать четыре отдельных блока")
    for node in graph["nodes"]:
        node["data"]["name"] = node_names[node["id"]]


def graph_fingerprint(graph):
    """Сравнивает графы без новых Snowflake id компилятора."""
    ids = {}

    def replace(match):
        value = match.group()
        if value not in ids:
            ids[value] = str(len(ids))
        return "<id:" + ids[value] + ">"

    normalized = re.sub(r"\d{15,}", replace, json.dumps(
        {"nodes": graph["nodes"], "edges": graph["edges"]},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ))
    return hashlib.sha256(normalized.encode()).hexdigest()


def current_graph(flow):
    version_id = str(flow["currentVersionId"])
    versions = [v for v in flow["flowVersions"] if str(v["id"]) == version_id]
    if len(versions) != 1:
        raise RuntimeError("У сценария отсутствует единственная опубликованная версия")
    return {key: versions[0][key] for key in ("nodes", "edges")}


def save_private(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, ensure_ascii=False)


async def run(args):
    import aiohttp
    from sqlalchemy import select
    from app.core.config import settings
    from app.core.database import AsyncSessionLocal, engine
    from app.models.automation import AutomationBot

    raw_token = settings.CHATBOTX_WORKSPACE_TOKEN
    workspace_token = raw_token.get_secret_value() if hasattr(raw_token, "get_secret_value") else raw_token
    if not workspace_token or not settings.CHATBOTX_API_URL:
        raise RuntimeError("Не настроен workspace API")
    # Эта область не использует channel client: у него другая база URL и другой токен.
    base = settings.CHATBOTX_API_URL.rstrip("/") + "/api/v1"
    try:
        async with AsyncSessionLocal() as db:
            bots = list((await db.execute(select(AutomationBot).where(
                AutomationBot.platform == "telegram", AutomationBot.bot_id.in_(BOT_IDS),
            ))).scalars())
        if len(bots) != 2 or {bot.bot_id for bot in bots} != set(BOT_IDS):
            raise RuntimeError("Нужны ровно два разрешённых тестовых Telegram бота")
        flow_ids = sorted({bot.flow_id for bot in bots if bot.flow_id})
        if not flow_ids or any(not value.isdigit() for value in flow_ids):
            raise RuntimeError("У тестовых ботов отсутствует корректный flow_id")
        if any(not bot.flow_id for bot in bots):
            raise RuntimeError("У одного из тестовых ботов не выбран сценарий")
        # Проверяем, что эти flow не разделяются с другим зарегистрированным ботом.
        async with AsyncSessionLocal() as db:
            shared = list((await db.execute(select(AutomationBot.bot_id).where(
                AutomationBot.flow_id.in_(flow_ids), AutomationBot.id.notin_([bot.id for bot in bots]),
            ))).scalars())
        if shared:
            raise RuntimeError("Тестовый сценарий используется другим ботом")
        backup = Path(tempfile.mkdtemp(prefix="supacrm-test-menus-", dir="/tmp"))
        os.chmod(backup, 0o700)
        print("Резервная копия и подготовленные графы: " + str(backup))
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout, headers={
            "Authorization": "Bearer " + workspace_token,
        }) as session:
            async def request(method, path, payload=None):
                async with session.request(method, base + path, json=payload, allow_redirects=False) as response:
                    if response.status >= 300:
                        # Не выводим тело провайдера: оно может содержать секреты/контент.
                        raise RuntimeError(f"API {method}: HTTP {response.status}")
                    return {} if response.status == 204 else await response.json()

            flows = {}
            for flow_id in flow_ids:
                flow = await request("GET", "/flows/" + flow_id)
                current_graph(flow)
                flows[flow_id] = flow
                save_private(backup / (flow_id + "-before.json"), flow)
            for flow_id in flow_ids:
                existing = flows[flow_id]
                greeting, check_reply = preserved_texts(current_graph(existing))
                graph = await request("POST", "/flows/validate", {"spec": menu_spec(greeting, check_reply)})
                apply_menu_names(graph, greeting, check_reply)
                save_private(backup / (flow_id + "-validated-graph.json"), graph)
                if graph_fingerprint(current_graph(existing)) == graph_fingerprint(graph):
                    print(f"flow {flow_id}: уже соответствует меню")
                    continue
                if not args.publish:
                    print(f"flow {flow_id}: проверен, готов к публикации")
                    continue
                latest = await request("GET", "/flows/" + flow_id)
                if latest != existing:
                    raise RuntimeError("Сценарий изменился после резервной копии; публикация остановлена")
                await request("POST", "/flows/" + flow_id + "/publish", graph)
                after = await request("GET", "/flows/" + flow_id)
                save_private(backup / (flow_id + "-after.json"), after)
                if graph_fingerprint(current_graph(after)) != graph_fingerprint(graph):
                    raise RuntimeError("Опубликованный граф отличается; требуется проверка")
                print(f"flow {flow_id}: опубликован и проверен")
        print("Резервная копия и подготовленный граф: " + str(backup))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true", help="Опубликовать после проверки и backup")
    options = parser.parse_args()
    try:
        asyncio.run(run(options))
    except Exception as error:
        # Исключаем traceback с URL и пользовательским содержимым.
        print("Подготовка остановлена: " + (str(error) if type(error) is RuntimeError else type(error).__name__))
        raise SystemExit(1) from None
