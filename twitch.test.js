import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverServers, dvrPath, parseLogin, parsePreviewUrl, searchChannels } from "./twitch.js";
import { parseIrcMessage } from "./chat.js";
import { twitchEmoteUrl } from "./emotes.js";

test("dvrPath matches a real DVR path seen on Twitch's CDN", async () => {
  assert.equal(
    await dvrPath("kato_junichi0817", "316597719537", Date.parse("2026-10-19T08:45:48Z")),
    "032a990a5aae368df829_kato_junichi0817_316597719537_1792399548",
  );
});

test("parsePreviewUrl turns a storyboard URL into the DVR playlist", () => {
  const preview = parsePreviewUrl(
    "https://d3fi1amfgojobc.cloudfront.net/e2ec5b5ecf05175441f1_melharucos_319061167846_1792394902/storyboards/2904894991-strip-0.jpg",
  );
  assert.deepEqual(preview, {
    server: "d3fi1amfgojobc",
    playlistUrl: "https://d3fi1amfgojobc.cloudfront.net/e2ec5b5ecf05175441f1_melharucos_319061167846_1792394902/chunked/index-dvr.m3u8",
    streamId: "319061167846",
    startedAt: 1792394902000,
  });
  assert.equal(parsePreviewUrl("https://vod-secure.twitch.tv/_404/404_processing_320x180.png"), null);
});

test("discoverServers lists each server of the live streams' previews once", async (t) => {
  const preview = (server, login) =>
    `https://${server}.cloudfront.net/${"a".repeat(20)}_${login}_1_2/storyboards/9-strip-0.jpg`;
  const edges = [
    { node: { archiveVideo: { animatedPreviewURL: preview("dnewserver12345", "a") } } },
    { node: { archiveVideo: null } },
    { node: { archiveVideo: { animatedPreviewURL: preview("dnewserver12345", "b") } } },
    { node: { archiveVideo: { animatedPreviewURL: preview("dother1234567", "c") } } },
  ];
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ data: { streams: { edges } } }) }));
  assert.deepEqual(await discoverServers(), ["dnewserver12345", "dother1234567"]);
});

test("parseLogin accepts names and channel URLs, rejects junk", () => {
  assert.equal(parseLogin("  Arthurperti "), "arthurperti");
  assert.equal(parseLogin("https://www.twitch.tv/arthurperti?sr=a"), "arthurperti");
  assert.equal(parseLogin('x"){ evil }'), null);
  assert.equal(parseLogin(""), null);
});

test("parseIrcMessage reads a tagged PRIVMSG and ignores the rest", () => {
  const line = "@color=#1E90FF;display-name=Foo;id=abc;tmi-sent-ts=1792394912000 :foo!foo@foo.tmi.twitch.tv PRIVMSG #melharucos :привет: всем";
  assert.deepEqual(parseIrcMessage(line, 1792394902000), {
    id: "abc", at: 10, sentAt: 1792394912000, author: "Foo", color: "#1E90FF",
    parts: [{ text: "привет: всем" }],
  });
  assert.equal(parseIrcMessage(":tmi.twitch.tv 001 justinfan1 :Welcome", 0), null);
  // a one-word message has no ":" before it (seen in real recent-messages output)
  const oneWord = "@display-name=どーず;id=x;tmi-sent-ts=1000;emotes :dozz_ow!dozz_ow@dozz_ow.tmi.twitch.tv PRIVMSG #ow_esports_jp ここでクイーンか";
  assert.deepEqual(parseIrcMessage(oneWord, 0).parts, [{ text: "ここでクイーンか" }]);
});

test("parseIrcMessage splits Twitch emotes out of the text, counting positions in characters", () => {
  // "😀 Kappa hi Kappa": the emoji is one character but two UTF-16 units
  const line = "@id=e;tmi-sent-ts=1000;emotes=25:2-6,11-15 :foo!foo@foo.tmi.twitch.tv PRIVMSG #c :😀 Kappa hi Kappa";
  assert.deepEqual(parseIrcMessage(line, 0).parts, [
    { text: "😀 " },
    { emote: twitchEmoteUrl("25"), name: "Kappa" },
    { text: " hi " },
    { emote: twitchEmoteUrl("25"), name: "Kappa" },
  ]);
});

test("searchChannels returns the login and display name of each match", async (t) => {
  const edges = [
    { node: { login: "whyl", displayName: "whyl" } },
    { node: { login: "whyloverr", displayName: "WHYLOVERR" } },
  ];
  const fetched = t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ data: { searchUsers: { edges } } }) }));
  assert.deepEqual(await searchChannels("whyl"), [
    { login: "whyl", displayName: "whyl" },
    { login: "whyloverr", displayName: "WHYLOVERR" },
  ]);
  assert.deepEqual(JSON.parse(fetched.mock.calls[0].arguments[1].body).variables, { q: "whyl" }); // the text is a variable, not part of the query
});
