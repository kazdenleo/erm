/**
 * CustomerDetail Page
 * Карточка клиента: контакты, статистика и история заказов
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { customersApi } from '../../services/customers.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { getOrderStatusLabel } from '../../constants/orderStatuses.js';
import { CustomerEditModal } from './CustomerEditModal';
import { formatBirthday, formatDate, formatDateTime, formatMoney, phoneHref } from './customerFormat';
import './Customers.css';

export function CustomerDetail() {
  const { customerId } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, o] = await Promise.all([
        customersApi.getById(customerId),
        customersApi.getOrders(customerId),
      ]);
      setCustomer(c);
      setOrders(o);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось загрузить клиента'));
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async () => {
    if (!customer) return;
    const hint = customer.ordersCount > 0
      ? `\n\nЗаказы клиента (${customer.ordersCount}) останутся, но будут отвязаны от карточки.`
      : '';
    if (!window.confirm(`Удалить клиента «${customer.name}»?${hint}`)) return;
    try {
      await customersApi.delete(customer.id);
      navigate('/customers', { replace: true });
    } catch (err) {
      alert(getApiErrorMessage(err, 'Не удалось удалить клиента'));
    }
  };

  if (loading && !customer) {
    return <div className="loading">Загрузка клиента...</div>;
  }

  if (error || !customer) {
    return (
      <div className="card">
        <Link to="/customers" className="customer-detail__back">← К списку клиентов</Link>
        <div className="error">{error || 'Клиент не найден'}</div>
      </div>
    );
  }

  const avgCheck = customer.ordersCount > 0 ? customer.totalAmount / customer.ordersCount : null;

  return (
    <div className="card customers-page">
      <Link to="/customers" className="customer-detail__back">← К списку клиентов</Link>
      <div className="customer-detail__header">
        <div>
          <h1 className="title" style={{ marginBottom: 4 }}>{customer.name}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Клиент с {formatDate(customer.createdAt)}
            {customer.source ? ` · ${customer.source}` : ''}
          </p>
        </div>
        <div className="customer-detail__actions">
          <Button
            variant="primary"
            size="small"
            onClick={() => navigate(`/orders?newOrderCustomer=${encodeURIComponent(customer.id)}`)}
          >
            ➕ Создать заказ
          </Button>
          <Button variant="secondary" size="small" onClick={() => setEditOpen(true)}>
            ✏️ Редактировать
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={handleDelete}
            style={{ color: '#fca5a5', borderColor: '#fca5a5' }}
          >
            🗑️ Удалить
          </Button>
        </div>
      </div>

      <div className="customer-detail__stats">
        <div className="customer-detail__stat">
          <div className="customer-detail__stat-label">Заказов</div>
          <div className="customer-detail__stat-value">{customer.ordersCount}</div>
        </div>
        <div className="customer-detail__stat">
          <div className="customer-detail__stat-label">Сумма покупок</div>
          <div className="customer-detail__stat-value">{formatMoney(customer.totalAmount)}</div>
        </div>
        <div className="customer-detail__stat">
          <div className="customer-detail__stat-label">Средний чек</div>
          <div className="customer-detail__stat-value">{avgCheck != null ? formatMoney(avgCheck) : '—'}</div>
        </div>
        <div className="customer-detail__stat">
          <div className="customer-detail__stat-label">Первый заказ</div>
          <div className="customer-detail__stat-value">{formatDate(customer.firstOrderAt)}</div>
        </div>
        <div className="customer-detail__stat">
          <div className="customer-detail__stat-label">Последний заказ</div>
          <div className="customer-detail__stat-value">{formatDate(customer.lastOrderAt)}</div>
        </div>
      </div>

      <div className="customer-detail__grid">
        <section className="customer-detail__section">
          <h3>Контакты</h3>
          <dl className="customer-detail__dl">
            <dt>Телефон</dt>
            <dd>{customer.phone ? <a href={phoneHref(customer.phone)}>{customer.phone}</a> : '—'}</dd>
            <dt>Email</dt>
            <dd>{customer.email ? <a href={`mailto:${customer.email}`}>{customer.email}</a> : '—'}</dd>
            <dt>Адрес</dt>
            <dd>{customer.address || '—'}</dd>
            <dt>Дата рождения</dt>
            <dd>{formatBirthday(customer.birthday)}</dd>
          </dl>
          <h3 style={{ marginTop: 16 }}>Заметки</h3>
          <div className="customer-detail__notes">
            {customer.notes ? customer.notes : <span className="text-muted">Нет заметок</span>}
          </div>
        </section>

        <section className="customer-detail__section">
          <h3>История заказов</h3>
          {orders.length === 0 ? (
            <div className="empty-state">
              <p>У клиента пока нет заказов</p>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table">
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Дата</th>
                    <th>Статус</th>
                    <th>Товары</th>
                    <th style={{ textAlign: 'right' }}>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.orderId}>
                      <td>
                        <Link to={`/orders/${o.marketplace || 'manual'}/${encodeURIComponent(o.orderId)}`}>
                          {o.orderId}
                        </Link>
                        {o.archived ? <div className="text-muted small">в архиве</div> : null}
                      </td>
                      <td>{formatDateTime(o.createdAt)}</td>
                      <td>{getOrderStatusLabel(o.status)}</td>
                      <td>
                        <div className="customer-detail__order-items" title={o.itemsSummary}>
                          {o.itemsSummary}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(o.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <CustomerEditModal
        isOpen={editOpen}
        customer={customer}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          void load();
        }}
      />
    </div>
  );
}
