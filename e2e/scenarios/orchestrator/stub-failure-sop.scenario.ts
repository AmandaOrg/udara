import { defineScenario, ScenarioSkipped } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { listOutboundSince, waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'orchestrator.stub.failure-sop',
  description:
    'With AI_PROVIDER=stub, free-text fallthrough yields failure SOP / recovery outbound',
  tags: ['orchestrator'],
  async run(ctx) {
    if (e2eEnv.orchestratorLive) {
      throw new ScenarioSkipped(
        'E2E_ORCHESTRATOR_LIVE=1 — stub SOP scenario skipped (use live scenario instead)',
      );
    }
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({
          from: wa,
          body: 'tell me a joke about saving money please',
        }).payload,
      ),
      200,
    );

    // Stub LLM emits no tool call → orchestrator ok:false → apology + menu.
    await waitForOutbound(wa, {
      after: started,
      contains: /give me a sec|glitched|lost my train of thought|menu|what would you like/i,
      timeoutMs: 25_000,
    });

    const outs = await listOutboundSince(wa, started);
    ctx.log(
      `outbound count=${outs.length}: ${outs.map((o) => o.textBody).join(' | ')}`,
    );
  },
});
