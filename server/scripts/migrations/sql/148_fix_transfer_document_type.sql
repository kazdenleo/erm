-- Migration: 148_fix_transfer_document_type.sql
-- Description: Исправить document_type у документов с номером ПМ-

UPDATE warehouse_receipts
SET document_type = 'transfer'
WHERE receipt_number ILIKE 'ПМ-%'
  AND COALESCE(document_type, 'receipt') <> 'transfer';
