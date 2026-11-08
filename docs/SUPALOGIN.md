# SUPAbuilder: общий конструктор и SUPAlogin

Собственный адаптер `packages/auth/src/supalogin*.ts` использует OpenAuth Authorization Code + PKCE. Это отдельный протокол интеграции SUPAcrm; существующий generic OAuth/SSO и проверки Enterprise не меняются.

## Допуск

1. Пользователь входит в SUPAcrm через SUPAlogin. CRM связывает проверенные `userId` и `email`.
2. Владелец выдаёт пользователю доступ в SUPAcrm. Регистрация в SUPAlogin сама по себе доступа к конструктору не даёт.
3. SUPAbuilder проверяет подпись/issuer/audience access token, затем вызывает `POST SUPACRM_ACCESS_URL` с серверным Bearer `SUPABUILDER_ACCESS_KEY` и `{userId,email}`.
4. Только `allowed:true` создаёт локальную учётную запись и membership в `SUPABUILDER_WORKSPACE_ID`. Каждый пользователь имеет отдельную сессию; боты и сценарии общие.
5. Проверка CRM выполняется при каждом чтении сессии, включая API и server actions. Отказ или недоступность CRM закрывает доступ. Изменение роли обновляет permissions и отзывает realtime-подключения через существующий service.

Старые пользователи без identity binding должны повторно войти в основную CRM. Новые пользователи добавляются только в общий workspace; создание дополнительных пространств и доступ к другим memberships в этом режиме запрещены. Machine API tokens транспорта ботов продолжают работать в своём пространстве.

## Настройки

Все переменные серверные. Примеры — `.env.example`. `SUPALOGIN_ISSUER` включает режим; неполная конфигурация отклоняется. В SUPAlogin регистрируется клиент `supabuilder` с единственным точным callback `<NEXT_PUBLIC_BUILDER_URL>/api/auth/supalogin/callback`.

`SUPALOGIN_BOOTSTRAP_SUBJECT` — явный subject администратора CRM, которому принадлежит существующее тестовое пространство. Его первый вход переносит технического владельца на эту личность; прежние браузерные сессии и password credential удаляются в той же транзакции. Workspace API tokens сохраняются для моста. Других пользователей нельзя связывать с существующей учётной записью только по email. Владелец workspace обязан оставаться администратором CRM; понижение этой роли блокирует его вход до решения вопроса передачи владения.

Локальные password/magic-link/signup/account-linking endpoints отключены при SUPAlogin. Полученный access token IdP используется только для проверки личности и не сохраняется в Account. State связан с подписанной HttpOnly/Secure/SameSite=Lax cookie, хранится серверно 10 минут, расходуется атомарно один раз. Возврат после входа ограничен путём общего workspace на origin конструктора.

## Проверки и границы

`packages/auth/__tests__/supalogin.test.ts` проверяет настоящий Better Auth + memory adapter: browser state, PKCE, replay, token/audience/CRM failures, session revoke, запрет локальных методов. `supalogin-membership.test.ts` проверяет bootstrap transaction и изменение ролей/cache/realtime. Workspace tests проверяют запрет создания/доступа к другому workspace и сохранение machine-token пути.

При недоступности CRM вход закрыт; не подменять это разрешением из устаревшего кеша. OAuth-коды, токены, пароли и серверный access key не логировать. Удаление доступа блокирует новые HTTP-операции; уже открытое realtime-соединение отзывается при следующей проверке сессии. Это не глобальное завершение сессий SUPAlogin.
