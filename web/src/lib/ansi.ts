// stripAnsi removes the common terminal escape sequences so the
// remaining text is readable. Naïve by design — we accept occasional
// junk on DCS / OSC edge cases since the consumers (preview tooltip,
// mention-badge regex match) are decorative / approximate.
//
// Extracted from SessionPreview so TerminalPane (C-5 mention badge)
// can reuse it without pulling the preview component into the tab
// hot path.
export function stripAnsi(s: string): string {
  return s
    // CSI: ESC [ params final-byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] ... BEL (or ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS / PM / APC / SOS: ESC P|X|^|_ ... ST
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Other single-char escapes (charset selection, etc.)
    .replace(/\x1b[()*+./][\s\S]/g, '')
    .replace(/\x1b[=>]/g, '')
    // Stray BEL / leftover ESCs
    .replace(/[\x07\x1b]/g, '');
}
