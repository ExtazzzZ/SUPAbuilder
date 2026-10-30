# SUPAcrm fork

Read AGENTS.md first. Upstream base: 2282d206ec5e407963e4639fbe177a1a35c5bc3d.

SUPAcrm owns Telegram/VK ingress, operator UI, orders/payments, and outbox delivery. Never connect the existing bot's native webhook to this fork. Route only explicitly selected bots to API channels. Never replay imported history as new automation input.

- Callback `operationId` is a logical action ID. Preserve it across retries; never hash text or use the HTTP delivery UUID as deduplication key. Include node visits to distinguish intentional loops.
- API flow sends without a durable logical ID must fail before HTTP. A callback acknowledgment means persisted acceptance, not Telegram/VK delivery.
- Build extensions through `@chatbotx.io/flow-config/extensions/supacrm`; the first entry compiles handoff/resume to the standard HTTP request block with success/error states. This is an executable block factory, not a separate palette item. New palette node types require the complete upstream registration cascade.
- Keep CRM action credentials server managed; never return compiled secret-bearing blocks to unauthorised viewers or log them. Handoff/resume is peer scoped, not a global bot pause.
- Keep commercial licensing and edition gates intact. Root MIT excludes proprietary directories; `packages/database/src/schema/enterprise/LICENSE` also declares commercial terms, and CE schema imports this directory. A source build is NOT proof of a distributable MIT-only CE artifact. Do not claim production license clearance.
- Use isolated data/queue namespaces. Do not run migrations on existing CRM or upstream databases. SUPAcrm integration runtime docs/scripts are maintained in SUPAcrm `v0/integrations/chatbotx`.

Checks: API integration tests, worker operation ID tests, business API provisioning tests, connections self-serve tests, flow-config extension tests, touched typechecks, root lint. Document upstream failures separately.
