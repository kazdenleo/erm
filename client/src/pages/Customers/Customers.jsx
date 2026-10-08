/**
 * Customers Page
 * База клиентов для частных заказов
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { customersApi } from '../../services/customers.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { CustomerEditModal } from './CustomerEditModal';
import { formatDate, formatMoney, phoneHref } from './customerFormat';
import './Customers.css';

const PAGE_SIZE = 50;
const EXPORT_PAGE_SIZE = 500;

const COLUMNS = [
  { key: 'name', label: 'Клиент', sortable: true },
  { key: 'phone', label: 'Телефон' },
  { key: 'email', label: 'Email' },
  { key: 'orders_count', label: 'Заказов', sortable: true, align: 'right' },
  { key: 'total_amount', label: 'Сумма', sortable: true, align: 'right' },
  { key: 'last_order_at', label: 'Последний заказ', sortable: true },
  { key: 'created_at', label: 'Добавлен', sortable: true },
];

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function Customers() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [modalCustomer, setModalCustomer] = useState(null);
  const [exporting, setExporting] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await customersApi.list({
        search: search || undefined,
        sort: sort.key,
        dir: sort.dir,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      if (reqId !== requestIdRef.current) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError(getApiErrorMessage(err, 'Не удалось загрузить клиентов'));
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [search, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' }
    );
    setPage(1);
  };

  const handleDelete = async (customer) => {
    const hint = customer.ordersCount > 0
      ? `\n\nЗаказы клиента (${customer.ordersCount}) останутся, но будут отвязаны от карточки.`
      : '';
    if (!window.confirm(`Удалить клиента «${customer.name}»?${hint}`)) return;
    try {
      await customersApi.delete(customer.id);
      await load();
    } catch (err) {
      alert(getApiErrorMessage(err, 'Не удалось удалить клиента'));
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const all = [];
      for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
        const res = await customersApi.list({
          search: search || undefined,
          sort: sort.key,
          dir: sort.dir,
          limit: EXPORT_PAGE_SIZE,
          offset,
        });
        all.push(...res.items);
        if (res.items.length < EXPORT_PAGE_SIZE || all.length >= res.total) break;
      }
      const header = ['Имя', 'Телефон', 'Email', 'Адрес', 'Дата рождения', 'Источник', 'Заказов', 'Сумма', 'Последний заказ', 'Заметки'];
      const rows = all.map((c) => [
        c.name, c.phone, c.email, c.address, c.birthday || '', c.source,
        c.ordersCount, c.totalAmount, c.lastOrderAt ? formatDate(c.lastOrderAt) : '', c.notes,
      ]);
      const csv = [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(getApiErrorMessage(err, 'Не удалось выгрузить клиентов'));
    } finally {
      setExporting(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="card customers-page">
      <h1 className="title">👥 Клиенты</h1>
      <p className="subtitle">База клиентов для частных заказов: контакты, история заказов и сумма покупок</p>

      <div className="customers-toolbar">
        <input
          type="search"
          className="form-control form-control-sm customers-search"
          placeholder="Поиск по имени, телефону, email или адресу"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <div className="customers-toolbar__actions">
          <Button variant="secondary" size="small" onClick={handleExport} disabled={exporting || total === 0}>
            {exporting ? 'Выгрузка...' : '⬇️ Выгрузить CSV'}
          </Button>
          <Button variant="primary" size="small" onClick={() => setModalCustomer({})}>
            ➕ Добавить клиента
          </Button>
        </div>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      <div className="customers-list">
        {loading && items.length === 0 ? (
          <div className="loading">Загрузка клиентов...</div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <p>{search ? 'Ничего не найдено' : 'Клиентов пока нет. Они появятся автоматически при создании частного заказа или их можно добавить вручную.'}</p>
          </div>
        ) : (
          <div className="table-responsive">
            <table className={`table customers-table${loading ? ' customers-table--loading' : ''}`}>
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      style={col.align ? { textAlign: col.align } : undefined}
                      className={col.sortable ? 'customers-th-sortable' : undefined}
                      onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                    >
                      {col.label}
                      {sort.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                  <th style={{ textAlign: 'right' }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="customers-row" onClick={() => navigate(`/customers/${c.id}`)}>
                    <td>
                      <div className="customers-name">{c.name}</div>
                      {c.address ? <div className="text-muted small customers-sub">{c.address}</div> : null}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {c.phone ? <a href={phoneHref(c.phone)}>{c.phone}</a> : '—'}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{c.ordersCount}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(c.totalAmount)}</td>
                    <td>{formatDate(c.lastOrderAt)}</td>
                    <td>{formatDate(c.createdAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="customers-actions">
                        <Button
                          variant="secondary"
                          size="small"
                          title="Редактировать"
                          onClick={() => setModalCustomer(c)}
                        >
                          ✏️
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          title="Удалить"
                          onClick={() => handleDelete(c)}
                          style={{ color: '#fca5a5', borderColor: '#fca5a5' }}
                        >
                          🗑️
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {total > PAGE_SIZE ? (
        <div className="customers-pagination">
          <Button variant="secondary" size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Назад
          </Button>
          <span className="text-muted small">
            Страница {page} из {pageCount} · всего {total}
          </span>
          <Button variant="secondary" size="small" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Вперёд →
          </Button>
        </div>
      ) : total > 0 ? (
        <div className="text-muted small customers-pagination">Всего клиентов: {total}</div>
      ) : null}

      <CustomerEditModal
        isOpen={modalCustomer != null}
        customer={modalCustomer?.id ? modalCustomer : null}
        onClose={() => setModalCustomer(null)}
        onSaved={() => {
          setModalCustomer(null);
          void load();
        }}
      />
    </div>
  );
}
