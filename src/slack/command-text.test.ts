import { describe, expect, it } from "vitest";
import { commandText } from "./command-text.js";

describe("commandText", () => {
  it("strips one leading bot mention for app_mention", () => {
    expect(commandText("<@U0BOTBOTB> /status", "U0BOTBOTB", "app_mention")).toBe(" /status");
    expect(commandText("  <@U0BOTBOTB>   /cancel", "U0BOTBOTB", "app_mention").trim()).toBe("/cancel");
  });

  it("leaves other mentions in place, so they fail to parse", () => {
    expect(commandText("<@U0OTHER00> /status", "U0BOTBOTB", "app_mention")).toBe("<@U0OTHER00> /status");
  });

  it("does not strip a mention from a DM message", () => {
    expect(commandText("<@U0BOTBOTB> /status", "U0BOTBOTB", "message")).toBe("<@U0BOTBOTB> /status");
  });

  it("restores Slack's HTML escaping, ampersand last", () => {
    expect(commandText("a &lt; b &gt; c &amp; d", "U0BOTBOTB", "message")).toBe("a < b > c & d");
    expect(commandText("&amp;lt;", "U0BOTBOTB", "message")).toBe("&lt;");
  });
});
