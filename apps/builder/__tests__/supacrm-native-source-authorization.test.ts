import { describe, expect, test, vi } from "vitest"
import { authorizeNativeSource } from "../src/lib/source-authoring-native/authorization"

const target = { workspaceId: "100", flowId: "200" }
function fixture() {
  const identity = vi.fn(async () => ({
    workspaceId: "100",
    subject: "verified-subject",
    flows: true,
  }))
  const binding = vi.fn(async () => ({
    kind: "source",
    bindingId: "binding",
    ...target,
    registryId: "11111111-1111-4111-8111-111111111111",
    bindingVersion: 1,
    capabilities: ["view", "slot", "compile", "validate", "publish"],
  }))
  return { identity, binding }
}

describe("штатный source редактор: server identity и сохранённая привязка", () => {
  test("actor берётся из проверенного SUPAlogin subject", async () => {
    const ports = fixture()
    const result = await authorizeNativeSource(target, ports)
    expect(result?.actor).toBe("verified-subject")
    expect(result?.binding.registryId).toBe(
      "11111111-1111-4111-8111-111111111111",
    )
  })

  test.each([
    null,
    { workspaceId: "100", subject: "s", flows: false },
    { workspaceId: "999", subject: "s", flows: true },
    { workspaceId: "100", subject: "", flows: true },
  ])("нет authority при неподходящей identity %j", async (identity) => {
    const ports = fixture()
    ports.identity.mockResolvedValue(identity as never)
    expect(await authorizeNativeSource(target, ports)).toBeNull()
    expect(ports.binding).not.toHaveBeenCalled()
  })

  test.each([
    { kind: "legacy", ...target },
    { kind: "blocked", code: "source_binding_unavailable" },
    { kind: "source", bindingId: "b", ...target, workspaceId: "999" },
    { kind: "source", bindingId: "b", ...target, flowId: "999" },
    { kind: "source", bindingId: "b", ...target, registryId: "not-a-registry" },
  ])("чужая, отсутствующая или повреждённая binding закрывает source доступ %j", async (value) => {
    const ports = fixture()
    ports.binding.mockResolvedValue(value as never)
    expect(await authorizeNativeSource(target, ports)).toBeNull()
  })

  test("отзыв проверяется новым запросом; успешный результат не кэшируется", async () => {
    const ports = fixture()
    expect(await authorizeNativeSource(target, ports)).not.toBeNull()
    ports.identity.mockResolvedValue(null as never)
    expect(await authorizeNativeSource(target, ports)).toBeNull()
    expect(ports.identity).toHaveBeenCalledTimes(2)
  })

  test("ошибка lookup не превращается в legacy или source разрешение", async () => {
    const ports = fixture()
    ports.binding.mockRejectedValue(new Error("private-database-detail"))
    expect(await authorizeNativeSource(target, ports)).toBeNull()
  })

  test("неканонические URL идентификаторы отвергаются до lookup", async () => {
    const ports = fixture()
    expect(
      await authorizeNativeSource(
        { workspaceId: "100/other", flowId: "200" },
        ports,
      ),
    ).toBeNull()
    expect(ports.identity).not.toHaveBeenCalled()
  })
})
