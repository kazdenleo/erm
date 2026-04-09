-- Простой SQL скрипт для создания базы данных
-- Использование: psql -U postgres -f scripts/create-db-simple.sql

-- Удаление базы данных, если существует (раскомментируйте, если нужно)
-- DROP DATABASE IF EXISTS erp_system;

-- Создание базы данных
CREATE DATABASE erp_system
    WITH 
    OWNER = postgres
    ENCODING = 'UTF8'
    LC_COLLATE = 'Russian_Russia.1251'
    LC_CTYPE = 'Russian_Russia.1251'
    TABLESPACE = pg_default
    CONNECTION LIMIT = -1;

-- Комментарий к базе данных
COMMENT ON DATABASE erp_system IS 'ERP System Database - основная база данных системы';

