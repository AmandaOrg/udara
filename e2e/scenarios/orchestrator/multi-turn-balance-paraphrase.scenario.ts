import { defineScenario, ScenarioSkipped } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'orchestrator.live.balance-paraphrase',
  description:
    'Opt-in live: paraphrased balance ask ("how much do I have left?") routes to balance read outbound',
  tags: ['orchestrator', 'live'],
  async run(ctx) {
    if (!e2eEnv.orchestratorLive) {
      throw new ScenarioSkipped(
        'Set E2E_ORCHESTRATOR_LIVE=1 and a real AI_PROVIDER on the server to run',
      );
    }
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({
          from: wa,
          body: 'how much do I have left?',
        }).payload,
      ),
      200,
    );
    const out = await waitForOutbound(wa, {
      after: started,
      contains: /account balance|₦/i,
      timeoutMs: 45_000,
    });
    ctx.log(`balance paraphrase reply: ${out.textBody?.slice(0, 120)}`);
  },
});
