import {
  createSupacrmProductNode,
  getSupacrmProduct,
} from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"

/** Палитра создаёт штатный sendMessage с семантикой товара, без нового runtime-типа. */
export function addSupacrmProductNode(
  reactFlow: ReactFlowInstance,
  t: TranslationFn,
): void {
  const version =
    reactFlow.getNodes().filter((node) => getSupacrmProduct(node.data.details))
      .length + 1
  reactFlow.addNodes([
    createSupacrmProductNode({
      dataProps: { name: `${t("supacrmProduct.label")} #${version}` },
      nodeProps: {
        position: reactFlow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    }),
  ])
}
