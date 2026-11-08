# История API-канала без запуска bot-flow

`POST /v1/channels/api/history` записывает уже обработанные сообщения в чат SUPAbuilder. Используется тот же Bearer-токен API-канала, что у `/v1/channels/api/messages`; токен ограничен одним inbox. Workspace/session token здесь не используется. Клиент не передаёт `workspaceId`, `inboxId`, внутренние идентификаторы контакта или диалога: они определяются на сервере.

Endpoint предназначен для событий, которые другой runtime уже обработал. Он не ставит `incomingMessage` в очередь, не вызывает automation/AI, не отправляет сообщения и не создаёт оплату. Для обычного запуска bot-flow остаётся `/v1/channels/api/messages`. Если сообщение уже прошло обычный runtime, history endpoint принимает его существующую запись по sourceId в том же диалоге, проверяя направление и принадлежность контакту; новая запись не создаётся.

```json
{
  "contact": { "sourceId": "supacrm:registry:peer", "firstName": "Тест" },
  "message": {
    "sourceId": "stable-external-message-id",
    "createdAt": "2026-11-03T10:00:00Z",
    "direction": "outgoing",
    "revision": 0,
    "text": "Выберите товар",
    "deliveryStatus": "delivered",
    "platformMessageId": "telegram-message-id",
    "attachments": [
      { "url": "https://example.com/photo.jpg", "fileType": "image", "mimeType": "image/jpeg" }
    ],
    "contentAttributes": { "type": "template", "payload": { "templateType": "button", "buttons": [{ "id": "catalog", "buttonType": "url", "label": "Открыть каталог", "url": "https://example.com/catalog" }] } }
  }
}
```

Ответ: `200 {"accepted":true,"messageId":"...","changed":true}`. Повтор или устаревшая ревизия возвращают `changed:false`. `Idempotency-Key` HTTP middleware допускается дополнительно; для разных ревизий он должен различаться.

`contact.sourceId` и `message.sourceId` должны быть стабильными. Сервер сначала ищет обычную запись по sourceId в своём диалоге, проверяет contactInboxId и направление. Если её нет, использует отдельное, однозначно закодированное пространство sourceId с inbox и контактом. История одного контакта не может перезаписать сообщение другого, даже если внешние message IDs совпадают. Новые контакты и диалоги создаются без событий автоматизации. Изменение направления или внешнего исходного времени сообщения запрещено; при принятии обычной записи её нативный createdAt сохраняется, внешний timestamp хранится в apiHistory.externalCreatedAt.

Каждая большая `revision` — **полный актуальный снимок**: передавать текст, вложения, контентные атрибуты и статус снова. `revision` — неотрицательное целое, по умолчанию 0. Для входящего события `direction=incoming`; кнопку или callback показывать понятным человеку текстом (`text`), не служебным payload. Кнопки/шаблоны можно хранить в `contentAttributes`; автоматизация их не исполняет. Вложения поддерживают `image`, `audio`, `video`, `gif`, `file` и сохраняются как обычные attachment rows.

Статусы: `queued`, `sent`, `delivered`, `read`, `failed`, `unknown`. Наличие истории не подтверждает отправку: статус приходит от источника. `platformMessageId` сохраняется, если следующая ревизия его не передала; менять уже известный ID запрещено. `deleted:true` заменяет видимый текст на «Сообщение удалено» и очищает видимые вложения; предыдущие снимки остаются в `contentAttributes.apiHistory.snapshots`. Там сохраняются прежний текст, вложения, контентные атрибуты, платформенный ID и статус. Проекция не удаляет реальное сообщение платформы.

Новая запись и правки публикуются в realtime чата. Множественные вложения сохраняются в БД; существующий realtime-протокол редактирования показывает первое изменённое вложение до перечитывания истории. Endpoint не скачивает вложения и не проверяет доступность URL.

Исторические даты расширяют нижнюю границу истории диалога и меняют только монотонные метки активности, не состояние bot-flow. Создание и ревизии одного контакта сериализованы транзакционной блокировкой PostgreSQL. Миграции схемы не требуются.

Проверки: `pnpm --filter @chatbotx.io/business exec vitest run src/api-history/__tests__/service.test.ts`.

Для исходящих сообщений, созданных обычным builder runtime, и входящих, пересланных в `/messages`, передавать `message.requireExisting:true`. Если асинхронный обработчик ещё не назначил `sourceId`, endpoint возвращает **409 CONFLICT**. Клиент повторяет только проекцию истории; исходный bot-flow/checkout повторять нельзя. Это устраняет гонку между отправкой и присвоением sourceId. Для сообщений, которые CRM обработала самостоятельно и не пересылала в builder runtime, флаг остаётся false. Для обычных исходящих sourceId равен ID CRM AutomationJob, возвращённому API callback; для обычных входящих — sourceId, переданному в `/messages`.
