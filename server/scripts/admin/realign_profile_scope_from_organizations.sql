-- Ручное разнесение данных по аккаунтам (profile_id) после миграции 083.
--
-- Миграция 083 одним значением привязала все старые строки к одному профилю
-- (greentaxi@list.ru или первый профиль). Если у вас несколько организаций с
-- разными profile_id в таблице organizations, этот скрипт переносит связанные
-- сущности на profile_id организации, чтобы аккаунты не «слипались».
--
-- ВАЖНО:
-- 1) Сделайте бэкап БД: sudo -u postgres pg_dump -Fc erp_system > /root/backup.dump
-- 2) Проверьте, что у organizations.profile_id заданы правильные значения
--    для каждого юрлица.
-- 3) Запуск: из каталога server:
--    node scripts/admin/run-sql-file.js scripts/admin/realign_profile_scope_from_organizations.sql
--
-- Товары без organization_id останутся на прежнем profile_id — при необходимости
-- обновите вручную или привяжите к организации в UI.
--
-- Интеграции (integrations): после разделения у каждого аккаунта должны быть
-- свои строки (profile_id + code). Дубликаты при необходимости создайте в UI
-- или скопируйте строки в SQL с новым profile_id.

BEGIN;

-- 1) Товары: профиль = профиль организации
UPDATE products p
SET profile_id = o.profile_id,
    updated_at = COALESCE(p.updated_at, CURRENT_TIMESTAMP)
FROM organizations o
WHERE p.organization_id = o.id
  AND o.profile_id IS NOT NULL
  AND p.profile_id IS DISTINCT FROM o.profile_id;

-- 2) Движения остатков — по товару
UPDATE stock_movements sm
SET profile_id = p.profile_id
FROM products p
WHERE sm.product_id = p.id
  AND sm.profile_id IS DISTINCT FROM p.profile_id;

-- 3) Заказы маркетплейсов — по карточке товара (если product_id задан)
UPDATE orders o
SET profile_id = p.profile_id,
    updated_at = COALESCE(o.updated_at, CURRENT_TIMESTAMP)
FROM products p
WHERE o.product_id = p.id
  AND o.profile_id IS DISTINCT FROM p.profile_id;

-- 4) Склады с привязкой к организации
UPDATE warehouses w
SET profile_id = o.profile_id,
    updated_at = COALESCE(w.updated_at, CURRENT_TIMESTAMP)
FROM organizations o
WHERE w.organization_id = o.id
  AND o.profile_id IS NOT NULL
  AND w.profile_id IS DISTINCT FROM o.profile_id;

-- 5) Закупки
UPDATE purchases pu
SET profile_id = o.profile_id,
    updated_at = COALESCE(pu.updated_at, CURRENT_TIMESTAMP)
FROM organizations o
WHERE pu.organization_id = o.id
  AND o.profile_id IS NOT NULL
  AND pu.profile_id IS DISTINCT FROM o.profile_id;

-- 6) Сессии инвентаризации — по профилю склада (если задан warehouse_id)
UPDATE inventory_sessions s
SET profile_id = w.profile_id
FROM warehouses w
WHERE s.warehouse_id = w.id
  AND w.profile_id IS NOT NULL
  AND s.profile_id IS DISTINCT FROM w.profile_id;

COMMIT;
