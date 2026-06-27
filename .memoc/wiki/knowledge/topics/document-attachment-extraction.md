---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-25T00:00:00
updated: 2026-06-25T00:00:00
status: active
tags:
  - memoc
  - memoc/topic
  - devil-codex
  - attachments
  - documents
  - providers
  - memoc/wiki
  - memoc/knowledge-wiki
confidence: medium
---
# Document Attachment Extraction

## Goal

Devil Codex must not rely on stock Codex-only attachment handling. When a user attaches documents in Devil, both routes should receive readable context:

```text
Codex model:
  Devil → app-server direct + extracted document context

External model:
  Devil → app-server modelProvider:"devil" → Devil proxy + extracted document context
```

## Current Implementation

Implemented in `src/main/document-attachments.cts`.

Main process enriches attachments at `turn:send` time before calling app-server/provider runtime:

```text
Renderer:
  attachment cards + visible user message

Main:
  read file attachment path
  extract text where possible
  append hidden "첨부 문서 ... 추출 내용" context to model input
  preserve attachment metadata for transcript rendering
```

## Supported First Pass

| Type | Handling |
|---|---|
| Text/code/data files | read as UTF-8 text |
| `.rtf` | basic RTF control-word stripping |
| `.docx` | built-in zip reader + `word/document.xml` extraction |
| `.pdf` | best-effort built-in PDF stream/text-token extraction |
| Other/binary | explicit extraction-failed/unsupported note |

Limits:

- Max file size: 16 MB.
- Max extracted chars per file: 40,000.
- Max total extracted chars per turn: 120,000.
- Existing renderer-provided text content is not duplicated.

## Why Not More Dashboard Work

Provider dashboard/log and model compatibility are useful only when they support debugging. They are not the next product priority. The next priority is attachment content fidelity.

## Known Limitations

- Scanned/image-only PDFs will not produce text.
- Complex PDF encodings may lose text.
- `.doc`, `.pptx`, `.xlsx`, and rich binary formats are not deeply parsed yet.
- A real PDF parser dependency may be needed later, but that should be a deliberate dependency decision.

## Manual Test Plan

1. Attach a small `.txt` and ask: "이 문서 첫 문장만 그대로 말해줘."
2. Attach a `.docx` with known text and ask for exact summary.
3. Attach a text-based `.pdf` and ask for a phrase known to exist in the PDF.
4. Repeat with Codex model and one external provider.
5. Confirm stock Codex sync still works after an external-provider document turn.
