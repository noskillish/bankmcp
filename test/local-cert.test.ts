import { test } from "node:test";
import assert from "node:assert/strict";
import selfsigned from "selfsigned";

process.env.BANKMCP_LOCAL = "1";
const { certificateStillGood } = await import("../src/local.ts");

const make = async (days: number) => {
  const notAfterDate = new Date(); notAfterDate.setDate(notAfterDate.getDate() + days);
  return (await selfsigned.generate([{ name: "commonName", value: "localhost" }], { keySize: 2048, notAfterDate, algorithm: "sha256" })).cert;
};

test("old 10-year certificates are replaced; 397-day ones are kept; expiring ones are replaced", async () => {
  assert.equal(certificateStillGood(await make(3650)), false);
  assert.equal(certificateStillGood(await make(397)), true);
  assert.equal(certificateStillGood(await make(10)), false);
  assert.equal(certificateStillGood("not a certificate"), false);
});
