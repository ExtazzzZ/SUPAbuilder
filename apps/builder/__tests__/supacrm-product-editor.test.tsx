// @vitest-environment jsdom
import {
  createSupacrmEmailNode,
  createSupacrmProductNode,
  selectSupacrmProduct,
} from "@chatbotx.io/flow-config"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AddNodeButton from "../src/features/flows/react-flow/panel-buttons/add-node-button"
import { SupacrmFormEditor } from "../src/features/flows/supacrm-form/form-editor"
import { SupacrmProductEditor } from "../src/features/flows/supacrm-product/product-editor"

const itemId = "123e4567-e89b-42d3-a456-426614174000"
const mocks = vi.hoisted(() => ({
  addNodes: vi.fn(),
  getNodes: vi.fn(() => []),
  getNode: vi.fn(),
  updateNodeData: vi.fn(),
  takeSnapshot: vi.fn(),
  refetch: vi.fn(),
  catalog: {
    status: "ok",
    items: [
      {
        id: "123e4567-e89b-42d3-a456-426614174000",
        title: "Текущий товар CRM",
        availability: "request",
        hasImage: false,
      },
    ],
  } as {
    status: string
    items: {
      id: string
      title: string
      availability: string
      hasImage: false
    }[]
  },
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    ...mocks,
    screenToFlowPosition: (position: unknown) => position,
  }),
  ControlButton: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}))
vi.mock("@/features/flows/react-flow/nodes/node-config", () => ({
  allNodesConfig: {},
}))
vi.mock("@/features/flows/react-flow/stores/use-flow-history", () => ({
  useFlowHistory: () => ({ takeSnapshot: mocks.takeSnapshot }),
}))
vi.mock("@/features/flows/supacrm-product/use-supacrm-catalog", () => ({
  useSupacrmProductImage: () => ({ data: { status: "ok", dataUrl: null } }),
  useSupacrmCatalog: () => ({
    data: mocks.catalog,
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: mocks.refetch,
  }),
}))
vi.mock("@chatbotx.io/ui/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    type?: "button" | "submit" | "reset"
  }) => (
    <button disabled={disabled} onClick={onClick} type={type ?? "button"}>
      {children}
    </button>
  ),
}))
vi.mock("@chatbotx.io/ui/components/ui/label", () => ({
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@chatbotx.io/ui/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AvatarFallback: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  AvatarImage: () => null,
}))
vi.mock("@chatbotx.io/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: () => null,
}))
vi.mock("@chatbotx.io/ui/components/ui/select", async () => {
  const { createContext, useContext } = await import("react")
  const Change = createContext<(id: string) => void>(() => undefined)
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: ReactNode
      onValueChange: (id: string) => void
    }) => <Change.Provider value={onValueChange}>{children}</Change.Provider>,
    SelectTrigger: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectValue: ({ children }: { children: ReactNode }) => (
      <span>{children}</span>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string
      children: ReactNode
    }) => {
      const change = useContext(Change)
      return (
        <button
          data-product-id={value}
          onClick={() => change(value)}
          type="button"
        >
          {children}
        </button>
      )
    },
  }
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.catalog = {
    status: "ok",
    items: [
      {
        id: itemId,
        title: "Текущий товар CRM",
        availability: "request",
        hasImage: false,
      },
    ],
  }
  mocks.getNodes.mockReturnValue([])
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("Блок Товар в палитре и редакторе", () => {
  it("поиск фильтрует feed и не изменяет выбранный товар", async () => {
    const node = createSupacrmProductNode({})
    mocks.getNode.mockReturnValue(node)
    await act(async () =>
      root.render(
        <SupacrmProductEditor
          nodeDetails={node.data.details}
          nodeId={node.id}
        />,
      ),
    )
    const search = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )
    expect(search).not.toBeNull()
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "нет такого")
      search?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(container.querySelector("[data-product-id]")).toBeNull()
    expect(mocks.updateNodeData).not.toHaveBeenCalled()
  })
  it("email inspector recompiles settings and preserves native outputs and section", async () => {
    const node = createSupacrmEmailNode({})
    node.data.editorMetadata = { section: { id: "receipt", title: "Почта" } }
    mocks.getNode.mockReturnValue(node)
    await act(async () =>
      root.render(
        <SupacrmFormEditor nodeDetails={node.data.details} nodeId={node.id} />,
      ),
    )
    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="prompt"]',
    )
    expect(prompt).not.toBeNull()
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(prompt, "Новый вопрос")
      prompt?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.click(),
    )
    const data = mocks.updateNodeData.mock.calls[0][1]
    expect(data.details.supacrmForm.prompt).toBe("Новый вопрос")
    expect(data.details.steps[0].text).toContain('"prompt":"Новый вопрос"')
    expect(data.details.quickReplies).toEqual(node.data.details.quickReplies)
    expect(data.editorMetadata).toEqual(node.data.editorMetadata)
  })
  it("пункт +Товар создаёт semantic product node", async () => {
    await act(async () => root.render(<AddNodeButton />))
    const button = Array.from(container.querySelectorAll("button")).find(
      (row) => row.textContent?.includes("supacrmProduct.label"),
    )
    expect(button).toBeDefined()
    await act(async () => button?.click())
    expect(mocks.addNodes).toHaveBeenCalledOnce()
    expect(
      mocks.addNodes.mock.calls[0][0][0].data.details.supacrmProduct,
    ).toEqual({ catalogItemId: "" })
  })
  it("выбор текущей позиции сериализует ID и marker без копии каталога", async () => {
    const node = createSupacrmProductNode({})
    mocks.getNode.mockReturnValue(node)
    await act(async () =>
      root.render(
        <SupacrmProductEditor
          nodeDetails={node.data.details}
          nodeId={node.id}
        />,
      ),
    )
    expect(container.textContent).toContain("Текущий товар CRM")
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-product-id]")?.click(),
    )
    const data = mocks.updateNodeData.mock.calls[0][1]
    expect(data.details.supacrmProduct).toEqual({ catalogItemId: itemId })
    expect(JSON.stringify(data)).not.toContain("Текущий товар CRM")
    expect(data.details.steps[0].text).toContain('"action":"catalog.detail"')
    expect(container.textContent).not.toContain("SUPACRM_ACTION_V1")
    const refresh = Array.from(container.querySelectorAll("button")).find(
      (row) => row.textContent?.includes("supacrmProduct.refresh"),
    )
    await act(async () => refresh?.click())
    expect(mocks.refetch).toHaveBeenCalledOnce()
  })
  it("удалённый товар показывает fallback без выдуманной цены", async () => {
    const node = selectSupacrmProduct(createSupacrmProductNode({}), itemId)
    mocks.catalog = { status: "ok", items: [] }
    await act(async () =>
      root.render(
        <SupacrmProductEditor
          nodeDetails={node.data.details}
          nodeId={node.id}
        />,
      ),
    )
    expect(container.textContent).toContain("supacrmProduct.missing")
    expect(container.textContent).not.toContain("SUPACRM_ACTION_V1")
    expect(mocks.updateNodeData).not.toHaveBeenCalled()
  })
})
