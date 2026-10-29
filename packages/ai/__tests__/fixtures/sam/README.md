# SAM 3.1 SSE fixtures

Event envelopes and output text come from a live `sam-3.1` image stream
(`stream: true`, `metadata.mask_encoding = "one_bit"`) captured by Meta in
`meta-models/meta-sam` → `typescript/packages/parser/test/fixtures/image-wheel.events.json`,
re-serialized as `text/event-stream` (`event: <type>` + `data: <json>`).

- `success.sse` — the captured stream: four objects, finalized by
  `response.content_part.done` (the live API never sends
  `response.output_text.done`), then `response.completed`.
- `no-match.sse` — the same envelope with an empty output-text lane (zero
  matches is a completed response with no records, per `protocol/sam3.md`).
- `error.sse` — the captured `response.created`/`response.in_progress`, then
  `response.failed`.
- `lossless.sse` — the verbatim `lossless` (`~`) mask output captured from a
  live API response in Meta's conformance corpus
  (`conformance/cases/captured-api-image-lossless.json`), split into the same
  three deltas and finalized like `success.sse`.
- `early-eof.sse` — the captured stream cut after the text delta, before any
  finalizer or terminal event.

`success.sse` and the output text of `lossless.sse` are verbatim captures; the
other three are derived from its
envelope because no live Muse credential was available when they were made.

To capture live replacements with a real Muse key, run
`scripts/test-ai-segment-image-e2e.mts --only client --record-dir <dir>`: it
writes `live-success.sse`, `live-no-match.sse` and `live-invalid-key.sse`
(response bodies only — the request and its API key are never recorded).
