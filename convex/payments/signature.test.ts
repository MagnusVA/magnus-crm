import { expect, test } from "vitest";
import { SIGNING_SECRET, TEST_TIME, signedHeaders } from "../../tests/whopFixtures";
import { verifyWhopSignature } from "./signature";

const body = '{"fixture":"signed payment π"}';
const bytes = new TextEncoder().encode(body);

test("verifies Whop's full UTF-8 secret and accepts any valid v1 signature", async () => {
  const secret = `${SIGNING_SECRET}_π`;
  const headers = await signedHeaders(body, "msg_fixture", secret);
  headers.set("webhook-signature", `v0,aGVsbG8= v1,%%% ${headers.get("webhook-signature")}`);
  await expect(verifyWhopSignature({ webhookSecret: secret }, headers, bytes, TEST_TIME))
    .resolves.toBe(true);
});

test("accepts the previous key only before its deadline", async () => {
  const headers = await signedHeaders(body, "msg_fixture");
  const connection = {
    webhookSecret: "ws_rotated_fixture",
    previousWebhookSecret: SIGNING_SECRET,
    previousWebhookSecretUntil: TEST_TIME + 1000,
  };
  await expect(verifyWhopSignature(connection, headers, bytes, TEST_TIME)).resolves.toBe(true);
  await expect(verifyWhopSignature(connection, headers, bytes, TEST_TIME + 1000)).resolves.toBe(false);
});

test("checks timestamp in both directions and verifies the exact body", async () => {
  const headers = await signedHeaders(body, "msg_fixture");
  const connection = { webhookSecret: SIGNING_SECRET };
  await expect(verifyWhopSignature(connection, headers, bytes, TEST_TIME + 301_000))
    .resolves.toBe(false);
  await expect(verifyWhopSignature(connection, headers, bytes, TEST_TIME - 301_000))
    .resolves.toBe(false);
  await expect(verifyWhopSignature(connection, headers, new TextEncoder().encode(body + "\n"), TEST_TIME))
    .resolves.toBe(false);
});

test("base64-decodes a Standard Webhooks whsec_ secret", async () => {
  const key = new TextEncoder().encode("synthetic-standard-key");
  const headers = await signedHeaders(body, "msg_fixture", key);
  const webhookSecret = `whsec_${btoa(String.fromCharCode(...key))}`;
  await expect(verifyWhopSignature({ webhookSecret }, headers, bytes, TEST_TIME)).resolves.toBe(true);
});
