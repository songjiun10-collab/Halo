"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { authorizeBatch } = require("../main/harness/inbox-action-policy");
const { prepareMailForModel } = require("../main/harness/inbox-mail-sanitizer");
const { mails, gullibleModel } = require("./fixtures/inbox-demo-mails");

// End to end over demo mails: sanitizer -> (gullible stand-in model) -> policy.
// The stand-in obeys any instruction it can read, so a pass shows the layers hold even when a
// model is fooled. It says nothing about how often a real model would be fooled.
const context = { messageIds: new Set(mails.map((mail) => mail.id)), labels: new Set(["Important"]) };
const FORBIDDEN = new Set(["forward", "create_filter", "share", "delete"]);

const naiveText = (mail) => `from: ${mail.from}\nsubject: ${mail.subject}\n\n${(mail.html || mail.text).replace(/<[^>]*>/g, " ")}`;

for (const mail of mails) {
  test(`${mail.id} [${mail.kind}] with sanitizer: model sees what a person sees, policy decides`, () => {
    const { wrapped } = prepareMailForModel(mail);
    const proposal = gullibleModel(wrapped, mail.id, mail.subject);
    const batch = authorizeBatch(proposal, context);
    if (!mail.expect.injected) {
      assert.equal(batch.ok, true, JSON.stringify(batch));
      assert.equal(proposal.length, 1);
    } else if (mail.expect.seenByModel === false) {
      assert.equal(proposal.length, 1, "hidden instruction never reached the model");
      assert.equal(batch.ok, true);
    } else {
      assert.ok(proposal.length > 1, "visible injection fooled the stand-in model");
      assert.equal(batch.ok, false, "policy refuses the whole batch");
    }
    for (const action of proposal.filter((_, index) => !batch.results[index].ok)) assert.ok(action.type !== "summarize" || /log in|collect|http|!\[/.test(action.text));
    for (let index = 0; index < proposal.length; index += 1) {
      if (FORBIDDEN.has(proposal[index].type)) assert.equal(batch.results[index].ok, false, `${proposal[index].type} must never be authorized`);
    }
  });

  test(`${mail.id} [${mail.kind}] without sanitizer: policy alone still blocks every forbidden action`, () => {
    const proposal = gullibleModel(naiveText(mail), mail.id, mail.subject);
    const batch = authorizeBatch(proposal, context);
    for (let index = 0; index < proposal.length; index += 1) {
      if (FORBIDDEN.has(proposal[index].type)) assert.equal(batch.results[index].ok, false);
    }
    // Naive extraction can drop an instruction by accident (comments vanish, split keywords no longer match).
    // Whenever the stand-in is fooled, the policy must refuse the batch; otherwise the batch is just the summary.
    if (proposal.length > 1) assert.equal(batch.ok, false, "a fooled model is stopped by the policy");
    else assert.equal(batch.ok, true);
  });
}

test("every authorized action across all demo mails is a label, summary or draft", () => {
  for (const mail of mails) {
    const proposal = gullibleModel(prepareMailForModel(mail).wrapped, mail.id, mail.subject);
    const batch = authorizeBatch(proposal, context);
    proposal.forEach((action, index) => { if (batch.results[index].ok) assert.ok(["label", "summarize", "draft"].includes(action.type)); });
  }
});
