import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const id = process.argv[2] || 'E400131';
const mode = (process.argv[3] || 'one').toLowerCase(); // one | list

const client = new pg.Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'erp_system',
  user: process.env.DB_USER || 'admin',
  ...(process.env.DB_PASSWORD ? { password: process.env.DB_PASSWORD } : {}),
});

const sqlOne = `
  SELECT id, profile_id, external_id, raw_payload
  FROM marketplace_questions
  WHERE marketplace = 'yandex'
    AND (
      external_id = $1
      OR raw_payload->'questionIdentifiers'->>'id' = $1
      OR raw_payload->'question_identifiers'->>'id' = $1
      OR raw_payload->'questionIdentifiers'->>'offerId' = $1
      OR raw_payload->'question_identifiers'->>'offerId' = $1
    )
  ORDER BY id DESC
  LIMIT 1
`;

const sqlListByOffer = `
  SELECT
    id,
    profile_id,
    external_id,
    raw_payload->'questionIdentifiers'->>'id' AS qid,
    raw_payload->'questionIdentifiers'->>'offerId' AS offer_id,
    raw_payload->>'text' AS text,
    raw_payload->>'createdAt' AS created_at
  FROM marketplace_questions
  WHERE marketplace = 'yandex'
    AND (
      sku_or_offer = $1
      OR raw_payload->'questionIdentifiers'->>'offerId' = $1
      OR raw_payload->'questionIdentifiers'->>'shopSku' = $1
      OR raw_payload->'questionIdentifiers'->>'offer_id' = $1
      OR raw_payload->'question_identifiers'->>'offerId' = $1
      OR raw_payload->'question_identifiers'->>'shopSku' = $1
      OR raw_payload->'question_identifiers'->>'offer_id' = $1
    )
  ORDER BY created_at ASC NULLS LAST, id ASC
  LIMIT 50
`;

async function main() {
  await client.connect();
  if (mode === 'list') {
    const r = await client.query(sqlListByOffer, [id]);
    console.log(JSON.stringify({ offerId: id, count: r.rows.length, rows: r.rows }, null, 2));
  } else {
    let r = await client.query(sqlOne, [id]);
    let row = r.rows[0] || null;
    if (!row) {
      const like = `%${String(id).trim()}%`;
      r = await client.query(
        `SELECT id, profile_id, external_id, raw_payload
         FROM marketplace_questions
         WHERE marketplace='yandex'
           AND (
             external_id ILIKE $1
             OR raw_payload::text ILIKE $1
           )
         ORDER BY id DESC
         LIMIT 1`,
        [like]
      );
      row = r.rows[0] || null;
    }
    console.log(JSON.stringify(row, null, 2));
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

