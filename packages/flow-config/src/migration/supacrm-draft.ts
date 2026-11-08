import {
  buttonStepDefaultFn,
  chooseChannelStepDefaultFn,
  sendMessageNodeDefaultFn,
  sendTextStepDefaultFn,
  startAnotherNodeStepDefaultFn,
  type FlowExport,
} from "../index"
import { supacrmExtensions } from "../extensions/supacrm"

/** Неактивный bot-flow: бизнес-операции выполняет CRM через подписанный API-канал. */
export function buildSupacrmMigrationDraft(): FlowExport {
  const catalogButton = {
    ...buttonStepDefaultFn({ label: "Каталог" }),
    buttonType: "startAnotherNode" as const,
    beforeStep: startAnotherNodeStepDefaultFn({ nodeId: "102" }),
  }
  const searchButton = {
    ...buttonStepDefaultFn({ label: "Поиск сервиса" }),
    buttonType: "startAnotherNode" as const,
    beforeStep: startAnotherNodeStepDefaultFn({ nodeId: "104" }),
  }
  const managerButton = {
    ...buttonStepDefaultFn({ label: "Менеджер" }),
    buttonType: "startAnotherNode" as const,
    beforeStep: startAnotherNodeStepDefaultFn({ nodeId: "103" }),
  }
  const main = sendMessageNodeDefaultFn({
    nodeProps: { id: "101", position: { x: 0, y: 0 } },
    dataProps: { name: "Главное меню", isStartNode: true },
  })
  main.data.details = {
    ...main.data.details,
    beforeStep: chooseChannelStepDefaultFn({ channel: "api" }),
    steps: [sendTextStepDefaultFn({ text: "Поможем оформить подписку на нейросеть. Выберите сервис в каталоге или напишите менеджеру." })],
    quickReplies: [catalogButton, searchButton, managerButton],
  }
  const commandNode = (id: string, name: string, text: string, x: number) => {
    const node = sendMessageNodeDefaultFn({ nodeProps: { id, position: { x, y: 300 } }, dataProps: { name } })
    node.data.details.beforeStep = chooseChannelStepDefaultFn({ channel: "api" })
    node.data.details.steps = [sendTextStepDefaultFn({ text })]
    return node
  }
  const home = () => ({
    ...buttonStepDefaultFn({ label: "Главное меню" }),
    buttonType: "startAnotherNode" as const,
    beforeStep: startAnotherNodeStepDefaultFn({ nodeId: "101" }),
  })
  const catalog = commandNode("102", "Каталог и тарифы CRM", supacrmExtensions["supacrm.catalog"].compile({}).text, 0)
  const manager = commandNode("103", "Заявка менеджеру", supacrmExtensions["supacrm.handoff"].compile({ paused: true }).text, 350)
  const search = commandNode("104", "Поиск сервиса в CRM", 'SUPACRM_ACTION_V1:{"action":"catalog.search_prompt","payload":{}}', 700)
  const catalogHome = home(), searchHome = home()
  catalog.data.details.quickReplies = [catalogHome]
  search.data.details.quickReplies = [searchHome]
  const edges = [[catalogButton.id, "102"], [managerButton.id, "103"], [searchButton.id, "104"]].map(([handle, target], i) => ({ id: `edge-${i}`, source: "101", sourceHandle: handle, target, targetHandle: target }))
  edges.push({ id: "edge-home-catalog", source: "102", sourceHandle: catalogHome.id, target: "101", targetHandle: "101" }, { id: "edge-home-search", source: "104", sourceHandle: searchHome.id, target: "101", targetHandle: "101" })
  return {
    formatVersion: 2,
    exportedAt: "2026-11-03T00:00:00.000Z",
    source: { workspaceId: "0", flowId: "0" },
    flows: [{ name: "Перенос Оплата нейросетей — черновик", active: false, enableInInbox: false, startNodeId: "101", nodes: [main, catalog, manager, search], edges }],
    customFields: {},
    botFields: {},
  }
}
