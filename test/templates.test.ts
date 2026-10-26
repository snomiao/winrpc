import { describe, expect, test } from "bun:test";
import { ahkTemplate } from "../src/ahk";

// Rendering only (AHK itself runs on Windows; the templates were checked on a Japanese Windows 11 host).
process.env.AHK_TEMPLATES_DIR = "/nonexistent-app-dir"; // winrpc's own ahk/ is the fallback

describe("winrpc's own templates", () => {
  test("find-owned-window inlines FindOwnedWindow and takes the vars; unset vars render empty", () => {
    const s = ahkTemplate("find-owned-window", { OWNER_EXE: "notepad.exe", CLASS: "#32770" });
    expect(s).toContain("FindOwnedWindow(ownerHwnd := 0");
    expect(s).toContain('FindOwnedWindow(ownerHwnd, "notepad.exe", "#32770", "")');
    expect(s).toContain('ownerArg := ""');
    expect(s).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("paste-text inlines ImeOff and decodes base64 text; restores the clipboard", () => {
    const text = 'C:\\tmp\\テスト "a`b".txt';
    const s = ahkTemplate("paste-text", { TEXT_B64: Buffer.from(text, "utf8").toString("base64"), CONTROL: "Edit1" });
    expect(s).toContain("ImeOff(hwnd := 0)");
    expect(s).toContain(`B64Decode("${Buffer.from(text, "utf8").toString("base64")}")`);
    expect(s).toContain("A_Clipboard := saved");
    expect(s).not.toContain(text); // the text never appears raw in the script
    expect(s).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("ime-off standalone", () => {
    const s = ahkTemplate("ime-off", { TARGET: "ahk_id 0x1A2B" });
    expect(s).toContain('target := "ahk_id 0x1A2B"');
    expect(s).toContain("IMC_SETOPENSTATUS");
  });

  test("values are inserted once: a value containing {{X}} is kept as it is", () => {
    const s = ahkTemplate("ime-off", { TARGET: "Report {{DRAFT}}" });
    expect(s).toContain('target := "Report {{DRAFT}}"');
  });

  test("every template declares AutoHotkey v2", () => {
    for (const n of ["find-owned-window", "paste-text", "ime-off"]) expect(ahkTemplate(n)).toContain("#Requires AutoHotkey v2.0");
  });

  test("an unknown template still fails loudly", () => {
    expect(() => ahkTemplate("no-such-template")).toThrow(/AHK template not found/);
  });
});
