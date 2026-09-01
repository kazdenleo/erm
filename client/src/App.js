/**
 * App Component
 * Главный компонент приложения
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { isProfileKitsEnabled, isProfileProductionEnabled } from './utils/profileFlags.js';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { ErrorBoundary } from './components/common/ErrorBoundary/ErrorBoundary.jsx';
import { Layout } from './components/layout/Layout/Layout';
import { Login } from './pages/Login/Login';
import { PublicRegister } from './pages/Register/PublicRegister.jsx';
import { FirstLoginChangePassword } from './pages/FirstLoginChangePassword/FirstLoginChangePassword.jsx';
import { Home } from './pages/Home/Home';
import { AnalyticsLayout } from './pages/Analytics/AnalyticsLayout';
import { SalesAnalytics } from './pages/Analytics/SalesAnalytics/SalesAnalytics';
import { FboSalesAnalytics } from './pages/Analytics/FboSalesAnalytics/FboSalesAnalytics';
import { CategorySalesAnalytics } from './pages/Analytics/CategorySalesAnalytics/CategorySalesAnalytics';
import { AbcSalesAnalytics } from './pages/Analytics/AbcSalesAnalytics/AbcSalesAnalytics';
import { ProductDynamics } from './pages/Analytics/ProductDynamics/ProductDynamics';
import { ProductTurnover } from './pages/Analytics/ProductTurnover/ProductTurnover';
import { CardWork } from './pages/Analytics/CardWork/CardWork';
import { Hypotheses } from './pages/Analytics/Hypotheses/Hypotheses';
import { Products } from './pages/Products/Products';
import { ProductsBulkEdit } from './pages/Products/ProductsBulkEdit';
import { ProductCard } from './pages/Products/ProductCard';
import { ProductEnrichment } from './pages/Products/ProductEnrichment';
import { Warehouses } from './pages/Warehouses/Warehouses';
import { Suppliers } from './pages/Suppliers/Suppliers';
import { Orders } from './pages/Orders/Orders';
import { Questions } from './pages/Questions/Questions';
import { Reviews } from './pages/Reviews/Reviews';
import { OrderDetail } from './pages/Orders/OrderDetail';
import { Shipments } from './pages/Shipments/Shipments';
import { Assembly } from './pages/Assembly/Assembly';
import { Production } from './pages/Production/Production';
import { PrintLabel } from './pages/PrintLabel/PrintLabel.jsx';
import { PrintProductLabel } from './pages/PrintProductLabel/PrintProductLabel.jsx';
import { PrintProductLabelsBatch } from './pages/PrintProductLabel/PrintProductLabelsBatch.jsx';
import { StockLevelsLayout } from './pages/StockLevels/StockLevelsLayout';
import { WarehouseStocks } from './pages/StockLevels/WarehouseStocks';
import { Purchases } from './pages/StockLevels/Purchases';
import { ChestnyZnakMarking } from './pages/StockLevels/ChestnyZnakMarking';
import { FboSupplies } from './pages/FboSupplies/FboSupplies';
import { FboSupplyDetail } from './pages/FboSupplies/FboSupplyDetail';
import { FboSupplyForecast } from './pages/FboSupplies/FboSupplyForecast';
import { FboPurchaseCalculation } from './pages/FboSupplies/FboPurchaseCalculation';
import { ProcurementForecast } from './pages/StockLevels/ProcurementForecast/ProcurementForecast';
import { Integrations } from './pages/Integrations/Integrations';
import { Notifications } from './pages/Notifications/Notifications';
import { Categories } from './pages/Categories/Categories';
import { Brands } from './pages/Brands/Brands';
import { Tasks } from './pages/Tasks/Tasks';
import { Prices } from './pages/Prices/Prices';
import { PricingStrategies } from './pages/Prices/PricingStrategies';
import { PricePromotions } from './pages/Prices/PricePromotions';
import { PriceHistory } from './pages/Prices/PriceHistory';
import { Settings } from './pages/Settings/Settings';
import { Attributes } from './pages/Settings/Attributes';
import { Certificates } from './pages/Settings/Certificates';
import { Labels } from './pages/Settings/Labels';
import { RichContentConstructor } from './pages/Settings/RichContentConstructor.jsx';
import { Organizations } from './pages/Organizations/Organizations';
import { SettingsUsers } from './pages/Settings/Users/Users';
import { Admin } from './pages/Admin/Admin';
import { Cabinet } from './pages/Cabinet/Cabinet';
import { Support } from './pages/Support/Support';
import { PlatformLayout } from './platform/PlatformLayout.jsx';
import { PlatformRoute } from './platform/PlatformRoute.jsx';
import { PlatformInquiries } from './platform/PlatformInquiries.jsx';
import { PlatformMarketplaceNotifications } from './platform/PlatformMarketplaceNotifications.jsx';
import './App.css';
import './styles/mp-badges.css';
import './styles/erp-filter-bar.css';
import './styles/mobile.css';

function ProductionRoute() {
  const { profile } = useAuth();
  const enabled = isProfileProductionEnabled(profile) && isProfileKitsEnabled(profile);
  if (!enabled) {
    return <Navigate to="/stock-levels/warehouse" replace />;
  }
  return (
    <Layout>
      <Production />
    </Layout>
  );
}

function ProductEnrichmentRoute() {
  return (
    <Layout>
      <ProductEnrichment />
    </Layout>
  );
}

/** Редирект со старых URL /fbo-supplies → /stock-levels/fbo-supplies */
function RedirectFboLegacy() {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.replace(/^\/fbo-supplies/, '') || '';
  return <Navigate to={`/stock-levels/fbo-supplies${rest}${search}${hash}`} replace />;
}

/** Редирект со старых URL /settings/rich-content → /products/rich-content */
function RedirectSettingsRichContent() {
  const { search, hash } = useLocation();
  return <Navigate to={`/products/rich-content${search}${hash}`} replace />;
}

function App() {
  return (
    <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <ErrorBoundary>
        <AuthProvider>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/platform-login" element={<Login mode="platform" />} />
          <Route path="/register" element={<PublicRegister />} />
          <Route
            path="/first-login-change-password"
            element={
              <ProtectedRoute>
                <FirstLoginChangePassword />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<ProtectedRoute><Layout><Home /></Layout></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><Layout><AnalyticsLayout /></Layout></ProtectedRoute>}>
            <Route index element={<Navigate to="/analytics/sales" replace />} />
            <Route path="sales" element={<SalesAnalytics />} />
            <Route path="fbo-sales" element={<FboSalesAnalytics />} />
            <Route path="categories" element={<CategorySalesAnalytics />} />
            <Route path="abc" element={<AbcSalesAnalytics />} />
            <Route path="dynamics" element={<ProductDynamics />} />
            <Route path="turnover" element={<ProductTurnover />} />
            <Route path="card-work" element={<CardWork />} />
            <Route path="hypotheses" element={<Hypotheses />} />
          </Route>
          <Route path="/admin" element={<Navigate to="/platform-login" replace />} />
          <Route path="/accounts" element={<Navigate to="/platform/accounts" replace />} />
          <Route
            path="/platform"
            element={
              <ProtectedRoute>
                <PlatformRoute>
                  <PlatformLayout />
                </PlatformRoute>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/platform/accounts" replace />} />
            <Route path="accounts" element={<Admin />} />
            <Route path="inquiries" element={<PlatformInquiries />} />
            <Route path="notifications" element={<PlatformMarketplaceNotifications />} />
          </Route>
          <Route path="/cabinet" element={<ProtectedRoute><Layout><Cabinet /></Layout></ProtectedRoute>} />
          <Route path="/support" element={<ProtectedRoute><Layout><Support /></Layout></ProtectedRoute>} />
          <Route path="/products/enrichment" element={<ProtectedRoute><ProductEnrichmentRoute /></ProtectedRoute>} />
          <Route path="/products/bulk-edit" element={<ProtectedRoute><Layout><ProductsBulkEdit /></Layout></ProtectedRoute>} />
          <Route path="/products/rich-content" element={<ProtectedRoute><Layout><RichContentConstructor /></Layout></ProtectedRoute>} />
          <Route path="/products/new" element={<ProtectedRoute><Layout><ProductCard /></Layout></ProtectedRoute>} />
          <Route path="/products/:productId" element={<ProtectedRoute><Layout><ProductCard /></Layout></ProtectedRoute>} />
          <Route path="/products" element={<ProtectedRoute><Layout><Products /></Layout></ProtectedRoute>} />
          <Route path="/stock-levels" element={<ProtectedRoute><Layout><StockLevelsLayout /></Layout></ProtectedRoute>}>
            <Route index element={<Navigate to="/stock-levels/warehouse" replace />} />
            <Route path="suppliers" element={<Navigate to="/stock-levels/warehouse" replace />} />
            <Route path="warehouse" element={<WarehouseStocks />} />
            <Route path="purchases/forecast" element={<ProcurementForecast />} />
            <Route path="purchases" element={<Purchases />} />
            <Route path="marking" element={<ChestnyZnakMarking />} />
            <Route path="fbo-supplies/purchase-calc" element={<FboPurchaseCalculation />} />
            <Route path="fbo-supplies/forecasting" element={<FboSupplyForecast />} />
            <Route path="fbo-supplies/:id" element={<FboSupplyDetail />} />
            <Route path="fbo-supplies" element={<FboSupplies />} />
            <Route path="problems" element={<Navigate to="/stock-levels/warehouse" replace />} />
          </Route>
          <Route path="/warehouses" element={<ProtectedRoute><Layout><Warehouses /></Layout></ProtectedRoute>} />
          <Route path="/suppliers" element={<ProtectedRoute><Layout><Suppliers /></Layout></ProtectedRoute>} />
          <Route path="/orders" element={<ProtectedRoute><Layout><Orders /></Layout></ProtectedRoute>} />
          <Route path="/questions" element={<ProtectedRoute><Layout><Questions /></Layout></ProtectedRoute>} />
          <Route path="/reviews" element={<ProtectedRoute><Layout><Reviews /></Layout></ProtectedRoute>} />
          <Route path="/returns" element={<Navigate to="/stock-levels/warehouse?op=return_customer" replace />} />
          <Route path="/wb-returns" element={<Navigate to="/stock-levels/warehouse?op=return_customer" replace />} />
          <Route path="/orders/:marketplace/:orderId" element={<ProtectedRoute><Layout><OrderDetail /></Layout></ProtectedRoute>} />
          <Route path="/shipments" element={<ProtectedRoute><Layout><Shipments /></Layout></ProtectedRoute>} />
          <Route path="/fbo-supplies/*" element={<ProtectedRoute><RedirectFboLegacy /></ProtectedRoute>} />
          <Route path="/assembly" element={<ProtectedRoute><Layout><Assembly /></Layout></ProtectedRoute>} />
          <Route path="/production" element={<ProtectedRoute><ProductionRoute /></ProtectedRoute>} />
          <Route path="/print/label/:orderId" element={<ProtectedRoute><PrintLabel /></ProtectedRoute>} />
          <Route path="/print/product-label/:productId" element={<ProtectedRoute><PrintProductLabel /></ProtectedRoute>} />
          <Route path="/print/product-labels-batch" element={<ProtectedRoute><PrintProductLabelsBatch /></ProtectedRoute>} />
          <Route path="/categories" element={<ProtectedRoute><Layout><Categories /></Layout></ProtectedRoute>} />
          <Route path="/brands" element={<ProtectedRoute><Layout><Brands /></Layout></ProtectedRoute>} />
          <Route path="/tasks" element={<ProtectedRoute><Layout><Tasks /></Layout></ProtectedRoute>} />
          <Route path="/prices" element={<ProtectedRoute><Layout><Prices /></Layout></ProtectedRoute>} />
          <Route path="/prices/strategies" element={<ProtectedRoute><Layout><PricingStrategies /></Layout></ProtectedRoute>} />
          <Route path="/prices/promotions" element={<ProtectedRoute><Layout><PricePromotions /></Layout></ProtectedRoute>} />
          <Route path="/prices/history" element={<ProtectedRoute><Layout><PriceHistory /></Layout></ProtectedRoute>} />
          <Route path="/integrations" element={<ProtectedRoute><Layout><Integrations /></Layout></ProtectedRoute>} />
          <Route path="/notifications" element={<ProtectedRoute><Layout><Notifications /></Layout></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Layout><Settings /></Layout></ProtectedRoute>} />
          <Route path="/settings/attributes" element={<ProtectedRoute><Layout><Attributes /></Layout></ProtectedRoute>} />
          <Route path="/settings/certificates" element={<ProtectedRoute><Layout><Certificates /></Layout></ProtectedRoute>} />
          <Route path="/settings/labels" element={<ProtectedRoute><Layout><Labels /></Layout></ProtectedRoute>} />
          <Route path="/settings/rich-content" element={<RedirectSettingsRichContent />} />
          <Route path="/settings/users" element={<ProtectedRoute><Layout><SettingsUsers /></Layout></ProtectedRoute>} />
          <Route path="/settings/roles" element={<Navigate to="/settings/users?tab=roles" replace />} />
          <Route path="/organizations" element={<ProtectedRoute><Layout><Organizations /></Layout></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
