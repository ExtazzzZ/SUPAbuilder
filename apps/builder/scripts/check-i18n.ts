import { readdir, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { checkTranslations } from "@lingual/i18n-check"

type Catalog = Record<string, unknown>

// Английская форма `one` означает 1, русская — также 21, 31 и т. д.
// Сравниваем такие ветви с эквивалентом, содержащим число.
// Все ключи перевода и аргументы ICU продолжают проходить проверку.
const countedRussianBranches = {
  "broadcasts.deleteDialog.description": [
    '"{name}" will be removed. Its data is deleted in the background.',
    "# broadcasts will be removed. Their data is deleted in the background.",
  ],
  "messages.sentAttachments": ["1 attachment", "# attachment"],
  "appointmentCalendars.reminderTimingLabels.hours": [
    "an hour before",
    "# hour before",
  ],
  "appointmentCalendars.reminderTimingLabels.days": [
    "a day before",
    "# day before",
  ],
  "workingHours.employeesDialog.clearAllAria": [
    "Clear the selected employee",
    "Clear {count} selected employee",
  ],
  "recurrence.summary.sentence": [
    "Every {frequency, select, daily {day} weekly {week} monthly {month} other {}}",
    "Every # {frequency, select, daily {day} weekly {week} monthly {month} other {}}",
  ],
} as const

export function russianComparisonSource(english: Catalog): Catalog {
  const source = structuredClone(english)
  for (const [key, [original, counted]] of Object.entries(
    countedRussianBranches,
  )) {
    const path = key.split(".")
    const leaf = path.pop() as string
    let parent = source
    for (const part of path) {
      parent = parent[part] as Catalog
    }
    const value = parent[leaf]
    const branch = `one {${original}}`
    if (typeof value !== "string" || !value.includes(branch)) {
      throw new Error(
        `Review Russian plural comparison after source change: ${key}`,
      )
    }
    const exactOne =
      key === "broadcasts.deleteDialog.description" ? `=1 {${original}} ` : ""
    parent[leaf] = value.replace(branch, `${exactOne}one {${counted}}`)
  }
  return source
}

function flatten(catalog: Catalog, prefix = ""): Catalog {
  const result: Catalog = {}
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(result, flatten(value as Catalog, path))
    } else {
      result[path] = value
    }
  }
  return result
}

export function checkCatalog(
  english: Catalog,
  target: Catalog,
  locale: string,
) {
  return checkTranslations(
    [
      {
        name: "en",
        reference: null,
        content: flatten(
          locale === "ru" ? russianComparisonSource(english) : english,
        ),
      },
    ],
    [{ name: locale, reference: "en", content: flatten(target) }],
    { format: "next-intl", checks: ["missingKeys", "invalidKeys"] },
  )
}

async function main() {
  const directory = new URL("../messages/", import.meta.url)
  const english = JSON.parse(
    await readFile(new URL("en.json", directory), "utf8"),
  ) as Catalog
  let invalid = false
  for (const filename of (await readdir(directory)).sort()) {
    if (!filename.endsWith(".json") || filename === "en.json") {
      continue
    }
    const target = JSON.parse(
      await readFile(new URL(filename, directory), "utf8"),
    ) as Catalog
    const result = checkCatalog(english, target, filename.slice(0, -5))
    if (
      Object.keys(result.missingKeys ?? {}).length ||
      Object.keys(result.invalidKeys ?? {}).length
    ) {
      console.error(filename, JSON.stringify(result, null, 2))
      invalid = true
    }
  }
  if (invalid) {
    process.exitCode = 1
  } else {
    console.log("All message catalogs pass missing-key and ICU validation.")
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
