/**
 * Home Page
 * Главная страница приложения
 */

import React from 'react';
import { Button } from '../../components/common/Button/Button';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';

export function Home() {
  return (
    <div>
      <PageTitle
        iconClass="pe-7s-graph2"
        iconBgClass="bg-mean-fruit"
        title="Analytics Dashboard"
        subtitle="Это страница-дашборд в стиле ArchitectUI (как на демо)."
        actions={(
          <>
            <Button className="btn-shadow me-2" variant="secondary" size="small">
              <i className="fa fa-star me-2" /> Избранное
            </Button>
            <Button className="btn-shadow" variant="info" size="small">
              <i className="fa fa-business-time me-2" /> Действия
            </Button>
          </>
        )}
      />

      <div className="row">
        <div className="col-md-6 col-xl-4">
          <div className="card mb-3 widget-content bg-midnight-bloom">
            <div className="widget-content-wrapper text-white">
              <div className="widget-content-left">
                <div className="widget-heading">Товары</div>
                <div className="widget-subheading">Всего в системе</div>
              </div>
              <div className="widget-content-right">
                <div className="widget-numbers text-white">
                  <span>—</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="col-md-6 col-xl-4">
          <div className="card mb-3 widget-content bg-arielle-smile">
            <div className="widget-content-wrapper text-white">
              <div className="widget-content-left">
                <div className="widget-heading">Заказы</div>
                <div className="widget-subheading">Активные</div>
              </div>
              <div className="widget-content-right">
                <div className="widget-numbers text-white">
                  <span>—</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="col-md-6 col-xl-4">
          <div className="card mb-3 widget-content bg-grow-early">
            <div className="widget-content-wrapper text-white">
              <div className="widget-content-left">
                <div className="widget-heading">Остатки</div>
                <div className="widget-subheading">Позиции с низким запасом</div>
              </div>
              <div className="widget-content-right">
                <div className="widget-numbers text-white">
                  <span>—</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="row">
        <div className="col-md-12 col-lg-6">
          <div className="mb-3 card">
            <div className="card-header-tab card-header-tab-animation card-header">
              <div className="card-header-title">
                <i className="header-icon lnr-apartment icon-gradient bg-love-kiss" /> Sales Report
              </div>
              <div className="btn-actions-pane-right">
                <div className="nav" role="tablist">
                  <Button className="btn-pill btn-wide btn-transition active me-1" variant="secondary" size="small">Last</Button>
                  <Button className="btn-pill btn-wide btn-transition" variant="secondary" size="small">Current</Button>
                </div>
              </div>
            </div>
            <div className="card-body">
              <div className="text-muted small">
                Здесь будет график/виджеты — сейчас оставил блок как на демо, но данные подключим позже.
              </div>
              <div className="mt-3 d-flex gap-2 flex-wrap">
                <Button variant="primary" size="small">Добавить товар</Button>
                <Button variant="secondary" size="small">Создать заказ</Button>
                <Button variant="success" size="small">Синхронизировать</Button>
              </div>
            </div>
          </div>
        </div>

        <div className="col-md-12 col-lg-6">
          <div className="mb-3 card">
            <div className="card-header">
              Active Users
              <div className="btn-actions-pane-right">
                <div role="group" className="btn-group-sm btn-group">
                  <Button className="active" variant="secondary" size="small">Last Week</Button>
                  <Button variant="secondary" size="small">All Month</Button>
                </div>
              </div>
            </div>
            <div className="table-responsive">
              <table className="align-middle mb-0 table table-borderless table-striped table-hover">
                <thead>
                  <tr>
                    <th className="text-center">#</th>
                    <th>Событие</th>
                    <th className="text-center">Статус</th>
                    <th className="text-center">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-center text-muted">#—</td>
                    <td>Пример строки</td>
                    <td className="text-center"><div className="badge bg-warning">Pending</div></td>
                    <td className="text-center"><Button variant="primary" size="small">Details</Button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="d-block text-center card-footer">
              <Button className="btn-wide" variant="success" size="small">Save</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

