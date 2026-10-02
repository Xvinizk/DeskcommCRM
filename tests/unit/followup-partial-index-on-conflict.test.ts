import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Follow-up Enrollment Events - ON CONFLICT Partial Index Inference (Bug C Fix)", () => {
  it("nenhum INSERT em followup_enrollment_events omite a cláusula WHERE do índice parcial", () => {
    const libDir = path.resolve(__dirname, "../../lib/followup");
    const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".ts"));

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const fullPath = path.join(libDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        if (
          line.includes("ON CONFLICT (enrollment_id, idempotency_key)") &&
          !line.includes("WHERE idempotency_key IS NOT NULL")
        ) {
          violations.push({
            file,
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("verifica a presença da cláusula WHERE nos arquivos críticos do motor de Node IA", () => {
    const idempotencyFile = path.resolve(__dirname, "../../lib/followup/ai-node-idempotency.ts");
    const lifecycleFile = path.resolve(__dirname, "../../lib/followup/ai-node-lifecycle.ts");

    const idemContent = fs.readFileSync(idempotencyFile, "utf-8");
    const lifeContent = fs.readFileSync(lifecycleFile, "utf-8");

    // ai-node-idempotency.ts deve conter 4 ocorrências com WHERE idempotency_key IS NOT NULL
    const idemMatches = idemContent.match(
      /ON CONFLICT \(enrollment_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/g,
    );
    expect(idemMatches).not.toBeNull();
    expect(idemMatches?.length).toBe(4);

    // ai-node-lifecycle.ts deve conter 12 ocorrências com WHERE idempotency_key IS NOT NULL
    const lifeMatches = lifeContent.match(
      /ON CONFLICT \(enrollment_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/g,
    );
    expect(lifeMatches).not.toBeNull();
    expect(lifeMatches?.length).toBe(12);
  });

  it("reproduz o contrato de inferência de índice parcial: SQL antigo vs SQL corrigido", () => {
    // Schema de referência:
    // CREATE UNIQUE INDEX idx_followup_events_idem ON followup_enrollment_events (enrollment_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    const partialIndexPredicate = "WHERE idempotency_key IS NOT NULL";

    const oldSql = `
      INSERT INTO followup_enrollment_events (
        organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING
    `;

    const newSql = `
      INSERT INTO followup_enrollment_events (
        organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (enrollment_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `;

    // PostgreSQL requer que o predicado do índice parcial seja especificado exatamente no ON CONFLICT
    function validateConflictInference(sqlQuery: string): { isValid: boolean; errorCode?: string } {
      if (sqlQuery.includes("ON CONFLICT (enrollment_id, idempotency_key)")) {
        if (!sqlQuery.includes(partialIndexPredicate)) {
          return {
            isValid: false,
            errorCode: "42P10", // there is no unique or exclusion constraint matching the ON CONFLICT specification
          };
        }
      }
      return { isValid: true };
    }

    const oldResult = validateConflictInference(oldSql);
    expect(oldResult.isValid).toBe(false);
    expect(oldResult.errorCode).toBe("42P10");

    const newResult = validateConflictInference(newSql);
    expect(newResult.isValid).toBe(true);
    expect(newResult.errorCode).toBeUndefined();
  });
});
