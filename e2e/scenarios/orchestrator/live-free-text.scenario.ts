import { defineScenario, ScenarioSkipped } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'orchestrator.live.free-text-reply',
  description:
    'Opt-in: with E2E_ORCHESTRATOR_LIVE=1 and a real AI_PROVIDER, free text gets a persona reply',
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
          body: 'hey, just saying hi — no need to open any menus',
        }).payload,
      ),
      200,
    );
    const out = await waitForOutbound(wa, {
      after: started,
      timeoutMs: 45_000,
    });
    ctx.log(`live orchestrator reply: ${out.textBody?.slice(0, 120)}`);
  },
});
