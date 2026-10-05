import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { claimJobs, completeJob, enqueueJob } from '@/lib/agent-engine/queue/queue';

/**
 * PROVA DE SERIALIZAÇÃO DE LANE POR CONTATO NA JOB_QUEUE.
 *
 * Garante que múltiplos jobs pertencentes ao MESMO contact_id nunca
 * sejam executados simultaneamente (exclusão mútua por lane).
 *
 * Passa pela query REAL de produção:
 *   NOT EXISTS (
 *     SELECT 1 FROM job_queue r
 *     WHERE r.contact_id = j.contact_id AND r.status = 'running'
 *   )
 * e pelo índice parcial:
 *   uniq_job_queue_one_running_per_contact ON job_queue (contact_id)
 *   WHERE status = 'running' AND contact_id IS NOT NULL;
 */

const TEST_DB_URL =
  process.env.TEST_DB_URL ||
  (process.env.TEST_DB_PORT
    ? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`
    : 'postgresql://postgres:postgres@test_pg_lane:5432/postgres');

const pool = new pg.Pool({
  connectionString: TEST_DB_URL,
  max: 10,
});

const ORG_ID = '11111111-1111-4000-8000-000000000001';
const CONTACT_X = '22222222-2222-4000-8000-000000000002';
const CONTACT_Y = '33333333-3333-4000-8000-000000000003';

describe('Queue Lane Serialization (contact_id lane exclusion)', () => {
  beforeAll(async () => {
    // Garante tabela limpa para os contatos de teste
    await pool.query(
      `DELETE FROM job_queue WHERE organization_id = $1 OR contact_id IN ($2, $3)`,
      [ORG_ID, CONTACT_X, CONTACT_Y]
    );
  });

  afterAll(async () => {
    try {
      await pool.query(
        `DELETE FROM job_queue WHERE organization_id = $1 OR contact_id IN ($2, $3)`,
        [ORG_ID, CONTACT_X, CONTACT_Y]
      );
    } catch {}
    await pool.end();
  });

  it('proves sequential lane execution: Worker 1 claims A, Worker 2 is blocked on B until A finishes', async () => {
    // ==================================================
    // 1. CRIAR CENÁRIO: Job A e Job B com o MESMO contact_id
    // ==================================================
    const { job: jobA } = await enqueueJob(pool, ORG_ID, {
      kind: 'inbound_turn',
      leadId: CONTACT_X,
      payload: { msg: 'Mensagem A' },
      priority: 10,
      runAfter: new Date(Date.now() - 1000), // vencido (run_after <= now)
    });

    const { job: jobB } = await enqueueJob(pool, ORG_ID, {
      kind: 'inbound_turn',
      leadId: CONTACT_X,
      payload: { msg: 'Mensagem B' },
      priority: 20, // menor prioridade que A
      runAfter: new Date(Date.now() - 1000), // vencido (run_after <= now)
    });

    expect(jobA.id).not.toBe(jobB.id);
    expect(jobA.contact_id).toBe(CONTACT_X);
    expect(jobB.contact_id).toBe(CONTACT_X);

    // ==================================================
    // 2. WORKER 1 CLAIM: A deve ser claimado, B deve permanecer pending
    // ==================================================
    const worker1Claims = await claimJobs(pool, {
      workerId: 'worker-unit-1',
      maxConcurrency: 10,
      batchSize: 10,
    });

    const claimedA = worker1Claims.find((j) => j.id === jobA.id);
    const claimedB = worker1Claims.find((j) => j.id === jobB.id);

    expect(claimedA).toBeDefined();
    expect(claimedA?.status).toBe('running');
    expect(claimedA?.locked_by).toBe('worker-unit-1');

    // B NÃO pode ter sido retornado no mesmo lote nem claimado
    expect(claimedB).toBeUndefined();

    // Consulta direta ao banco para confirmar status real de B
    const bCheck1 = await pool.query(`SELECT status, locked_by FROM job_queue WHERE id = $1`, [
      jobB.id,
    ]);
    expect(bCheck1.rows[0]?.status).toBe('pending');
    expect(bCheck1.rows[0]?.locked_by).toBeNull();

    // Confirmar que para CONTACT_X há EXATAMENTE 1 job running
    const runningCount1 = await pool.query(
      `SELECT count(*)::int as count FROM job_queue WHERE contact_id = $1 AND status = 'running'`,
      [CONTACT_X]
    );
    expect(runningCount1.rows[0]?.count).toBe(1);

    // ==================================================
    // 3. WORKER 2 TENTA CLAIM ENQUANTO A ESTÁ RUNNING: B DEVE SER BLOQUEADO
    // ==================================================
    const worker2ClaimsWhileRunning = await claimJobs(pool, {
      workerId: 'worker-unit-2',
      maxConcurrency: 10,
      batchSize: 10,
    });

    const claimedBWhileRunning = worker2ClaimsWhileRunning.find((j) => j.id === jobB.id);
    expect(claimedBWhileRunning).toBeUndefined();

    // B continua pending no banco
    const bCheck2 = await pool.query(`SELECT status, locked_by FROM job_queue WHERE id = $1`, [
      jobB.id,
    ]);
    expect(bCheck2.rows[0]?.status).toBe('pending');
    expect(bCheck2.rows[0]?.locked_by).toBeNull();

    const QUEUE_LANE_BLOCKED_SECOND_JOB = claimedBWhileRunning === undefined && bCheck2.rows[0]?.status === 'pending';
    expect(QUEUE_LANE_BLOCKED_SECOND_JOB).toBe(true);

    // ==================================================
    // 4. FINALIZAR JOB A USANDO FUNÇÃO CANÔNICA (completeJob)
    // ==================================================
    await completeJob(pool, jobA.id, 'worker-unit-1');

    const aCheckAfterDone = await pool.query(`SELECT status FROM job_queue WHERE id = $1`, [
      jobA.id,
    ]);
    expect(aCheckAfterDone.rows[0]?.status).toBe('done');

    // ==================================================
    // 5. WORKER 2 TENTA NOVAMENTE APÓS A ESTAR DONE: B AGORA DEVE SER CLAIMADO
    // ==================================================
    const worker2ClaimsAfterDone = await claimJobs(pool, {
      workerId: 'worker-unit-2',
      maxConcurrency: 10,
      batchSize: 10,
    });

    const claimedBAfterDone = worker2ClaimsAfterDone.find((j) => j.id === jobB.id);
    expect(claimedBAfterDone).toBeDefined();
    expect(claimedBAfterDone?.status).toBe('running');
    expect(claimedBAfterDone?.locked_by).toBe('worker-unit-2');

    const B_CLAIMED_AFTER_A_DONE = claimedBAfterDone?.status === 'running';
    expect(B_CLAIMED_AFTER_A_DONE).toBe(true);

    // Finaliza B canonicamente
    await completeJob(pool, jobB.id, 'worker-unit-2');
    const bFinal = await pool.query(`SELECT status FROM job_queue WHERE id = $1`, [jobB.id]);
    expect(bFinal.rows[0]?.status).toBe('done');
  });

  it('guarantees multi-worker safety under concurrent claim race: MAX_RUNNING_FOR_CONTACT is strictly 1', async () => {
    // ==================================================
    // 6. MULTI-WORKER SAFETY: Dois workers disputam simultaneamente jobs do MESMO contato
    // ==================================================
    const { job: jobC } = await enqueueJob(pool, ORG_ID, {
      kind: 'inbound_turn',
      leadId: CONTACT_Y,
      payload: { msg: 'Mensagem C' },
      priority: 10,
      runAfter: new Date(Date.now() - 1000),
    });

    const { job: jobD } = await enqueueJob(pool, ORG_ID, {
      kind: 'inbound_turn',
      leadId: CONTACT_Y,
      payload: { msg: 'Mensagem D' },
      priority: 10,
      runAfter: new Date(Date.now() - 1000),
    });

    // Chamadas concorrentes simultâneas de claimJobs
    const [claimsW1, claimsW2] = await Promise.all([
      claimJobs(pool, { workerId: 'worker-race-1', maxConcurrency: 10 }),
      claimJobs(pool, { workerId: 'worker-race-2', maxConcurrency: 10 }),
    ]);

    const claimedForContactY = [...claimsW1, ...claimsW2].filter(
      (j) => j.id === jobC.id || j.id === jobD.id
    );

    // Exatamente 1 job deve ter sido claimado no total entre os dois workers
    expect(claimedForContactY.length).toBe(1);

    // Consulta de banco: contagem de jobs 'running' para CONTACT_Y NUNCA pode ser > 1
    const dbRunningCount = await pool.query(
      `SELECT count(*)::int as count FROM job_queue WHERE contact_id = $1 AND status = 'running'`,
      [CONTACT_Y]
    );
    expect(dbRunningCount.rows[0]?.count).toBe(1);

    // Limpa jobs criados
    await pool.query(`UPDATE job_queue SET status = 'done' WHERE contact_id = $1`, [CONTACT_Y]);
  });
});
