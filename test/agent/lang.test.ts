// edgelore · Agent Memory layer — language pinning tests.
//
// detectLang must be confident-only: real drift samples (full sentences in a
// foreign language) get labeled; English sentences that merely MENTION foreign
// brand names must stay ambiguous; numbers and proper-noun strings always
// pass. The enforcement paths (per-turn extract, batch filter) drop only
// confident mismatches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLang, dominantLang, filterByLanguage } from "../../src/agent/lang.js";
import { runExtract } from "../../src/agent/extract.js";
import type { LlmDriver } from "../../src/agent/llm-driver.js";

test("lang: confident English is labeled en", () => {
  assert.equal(detectLang("I attended a backyard BBQ party at my colleague's house and it was great."), "en");
});

test("lang: confident Spanish is labeled es", () => {
  assert.equal(
    detectLang("Colección de cámaras vintage, incluye 17 cámaras y un set completo de figuras del Universo"),
    "es",
  );
  assert.equal(detectLang("Planea usar una Pilsner en la fiesta del sábado por la tarde"), "es");
});

test("lang: Chinese is labeled zh", () => {
  assert.equal(detectLang("第一次给车做保养，2023-03-15，体验很好"), "zh");
  assert.equal(detectLang("计划近期做汽车打蜡和精洗，考虑每3-4个月一次"), "zh");
});

test("lang: English mentioning foreign brand names stays unlabeled or en — never es", () => {
  const verdict = detectLang("Recommended blanco (Avion Silver, Casa Noble Crystal, Espolón Blanco) or reposado tequilas for the pairing");
  assert.notEqual(verdict, "es");
  const verdict2 = detectLang("Recommended Blue Bottle, Intelligentsia, La Colombe, Angels' Cup, Bean Box roasters");
  assert.notEqual(verdict2, "es");
});

test("lang: bare numbers, codes and proper-noun strings are ambiguous (always pass)", () => {
  assert.equal(detectLang("32"), null);
  assert.equal(detectLang("2023-05-20"), null);
  assert.equal(detectLang("Zip code 23456"), null);
});

test("lang: dominantLang reads a whole transcript", () => {
  const t = "[user] I have been meaning to ask about hiking trails near the city.\n[assistant] There are several good options, and the river trail is the most popular one for beginners.";
  assert.equal(dominantLang(t), "en");
  assert.equal(dominantLang("[user] 我上周六参加了同事的后院烧烤，聊到了育儿经验。"), "zh");
});

test("lang: filter keeps matches and ambiguous, drops confident mismatches", () => {
  const items = [
    { v: "I finished the book last week" },
    { v: "Colección de discos de vinilo con un pressing raro de 1978" },
    { v: 5000 },
    { v: "32 miles per gallon" },
  ];
  const r = filterByLanguage(items, (i) => i.v, "en");
  assert.deepEqual(r.keep, [items[0], items[2], items[3]]);
  assert.deepEqual(r.dropped, [items[1]]);
});

test("extract: per-turn path drops foreign-language entries, keeps the rest", async () => {
  const driver = {
    async complete(): Promise<string> {
      return JSON.stringify({
        contents: [
          { dimensionKey: "NEW:tripDrive", value: "I drove for six hours to the capital recently", saidBy: "user" },
          { dimensionKey: "NEW:coleccionVinilos", value: "Colección de discos de vinilo con pressing raro de 1978", saidBy: "user" },
        ],
      });
    },
  } as unknown as LlmDriver;
  const r = await runExtract({
    text: "[user] By the way, I drove for six hours to the capital recently, and I also told you about my record collection.",
    candidates: ["drove for six hours", "record collection"],
    knownDimensions: [],
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "STORE");
  assert.equal(r.contents?.length, 1);
  assert.equal(r.contents?.[0].dimensionKey, "tripDrive");
});

test("extract: all-foreign reply becomes NOOP with the foreign-language reason", async () => {
  const driver = {
    async complete(): Promise<string> {
      return JSON.stringify({
        contents: [{ dimensionKey: "NEW:coleccion", value: "Colección de cámaras vintage con 17 cámaras", saidBy: "user" }],
      });
    },
  } as unknown as LlmDriver;
  const r = await runExtract({
    text: "[user] I was telling you about my camera collection and the vintage fair last weekend.",
    candidates: ["camera collection"],
    knownDimensions: [],
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "NOOP");
  assert.match(r.reason ?? "", /foreign language/);
});

test("extract: Chinese turn keeps Chinese entries and drops drifted English ones", async () => {
  const driver = {
    async complete(): Promise<string> {
      return JSON.stringify({
        contents: [
          { dimensionKey: "NEW:carService", value: "第一次给车做保养，2023-03-15，体验很好", saidBy: "user" },
          { dimensionKey: "NEW:driftedPlan", value: "I am planning to drive to the beach next weekend", saidBy: "user" },
        ],
      });
    },
  } as unknown as LlmDriver;
  const r = await runExtract({
    text: "[user] 我上周做了保养，另外还在考虑下周末开车去海边。",
    candidates: ["做了保养", "开车去海边"],
    knownDimensions: [],
    contextMemories: [],
    driver,
  });
  assert.equal(r.action, "STORE");
  assert.equal(r.contents?.length, 1);
  assert.equal(r.contents?.[0].dimensionKey, "carService");
});
