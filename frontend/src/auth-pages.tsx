import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, apiService } from './lib/api';
import { useAuthStore } from './store/auth';
import { Card } from './components/ui';
import type { RegisterInput } from './types';

const usernameRules = { required: 'Nhập tên đăng nhập.', pattern: { value: /^[A-Za-z0-9_.-]{3,64}$/, message: 'Dùng 3–64 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.' } };
const passwordRules = { required: 'Nhập mật khẩu.', minLength: { value: 8, message: 'Mật khẩu cần ít nhất 8 ký tự.' }, maxLength: { value: 128, message: 'Mật khẩu tối đa 128 ký tự.' } };
function Brand() { return <div className="brand large"><div className="brand-mark">SC</div><span>Smart Classroom</span></div>; }

export function Login() {
  const { user, login, notice } = useAuthStore();
  const nav = useNavigate();
  const location = useLocation();
  const queries = useQueryClient();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { isSubmitting, errors } } = useForm<{ username: string; password: string }>();
  if (user) return <Navigate to="/dashboard" replace />;
  return <div className="login-page"><div className="login-card">
    <Brand /><h1 className="auth-title">Đăng nhập</h1><p className="muted">Quyền truy cập được xác định theo tài khoản của bạn.</p>
    {(location.state?.message || notice) && <p className="notice" role="status">{location.state?.message || notice}</p>}
    <form onSubmit={handleSubmit(async values => {
      setError('');
      try { const session = await apiService.login(values.username, values.password); queries.clear(); login(session.access_token, session.user); nav('/dashboard', { replace: true }); }
      catch (error) { setError(apiErrorMessage(error, 'Tên đăng nhập hoặc mật khẩu không đúng.')); }
    })}>
      <label>Tên đăng nhập<input {...register('username', usernameRules)} autoComplete="username" maxLength={64} /></label>
      {errors.username && <span className="field-error">{errors.username.message}</span>}
      <label>Mật khẩu<input {...register('password', { required: 'Nhập mật khẩu.', maxLength: 128 })} type="password" autoComplete="current-password" maxLength={128} /></label>
      {errors.password && <span className="field-error">{errors.password.message}</span>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary full" disabled={isSubmitting}>{isSubmitting ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
    </form>
    <p className="auth-link">Chưa có tài khoản? <Link to="/register">Đăng ký</Link></p>
    <div className="role-guide"><span><strong>Admin</strong> Quản lý hệ thống và tài khoản</span><span><strong>Operator</strong> Giám sát và điều khiển phòng được giao</span><span><strong>Viewer</strong> Xem dữ liệu phòng được giao</span></div>
    {import.meta.env.VITE_USE_MOCK === 'true' && <div className="demo-hint">Mock: admin / operator / viewer · mật khẩu <b>Smart@123456</b>. Thay đổi tài khoản chỉ tồn tại trong phiên chạy thử.</div>}
  </div></div>;
}

export function Register() {
  const user = useAuthStore(state => state.user);
  const nav = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, getValues, formState: { isSubmitting, errors } } = useForm<RegisterInput & { confirm: string }>();
  if (user) return <Navigate to="/dashboard" replace />;
  return <div className="login-page"><div className="login-card">
    <Brand /><h1 className="auth-title">Đăng ký tài khoản</h1><p className="muted">Tài khoản mới có quyền Viewer. Admin sẽ cấp quyền và gán phòng cho bạn.</p>
    <form onSubmit={handleSubmit(async ({ confirm: _confirm, ...input }) => {
      setError('');
      try { await apiService.register(input); nav('/login', { replace: true, state: { message: 'Đăng ký thành công. Bạn có thể đăng nhập bằng tài khoản vừa tạo.' } }); }
      catch (error) { setError(apiErrorMessage(error)); }
    })}>
      <label>Họ và tên<input {...register('display_name', { required: 'Nhập họ và tên.', maxLength: 100, validate: value => Boolean(value.trim()) || 'Nhập họ và tên.' })} autoComplete="name" maxLength={100} /></label>
      {errors.display_name && <span className="field-error">{errors.display_name.message}</span>}
      <label>Tên đăng nhập<input {...register('username', usernameRules)} autoComplete="username" maxLength={64} /></label>
      {errors.username && <span className="field-error">{errors.username.message}</span>}
      <label>Mật khẩu<input {...register('password', passwordRules)} type="password" autoComplete="new-password" maxLength={128} /></label>
      <span className="muted small">Từ 8 đến 128 ký tự.</span>
      {errors.password && <span className="field-error">{errors.password.message}</span>}
      <label>Nhập lại mật khẩu<input {...register('confirm', { required: 'Nhập lại mật khẩu.', validate: value => value === getValues('password') || 'Mật khẩu nhập lại không khớp.' })} type="password" autoComplete="new-password" maxLength={128} /></label>
      {errors.confirm && <span className="field-error">{errors.confirm.message}</span>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary full" disabled={isSubmitting}>{isSubmitting ? 'Đang đăng ký…' : 'Đăng ký'}</button>
    </form>
    <div className="auth-link"><button type="button" className="secondary full" onClick={() => nav('/login')}>← Quay lại đăng nhập</button></div>
  </div></div>;
}

export function ChangePassword() {
  const logout = useAuthStore(state => state.logout);
  const nav = useNavigate();
  const queries = useQueryClient();
  const [error, setError] = useState('');
  const { register, handleSubmit, getValues, formState: { isSubmitting, errors } } = useForm<{ current: string; next: string; confirm: string }>();
  return <div className="account-page"><h2>Đổi mật khẩu</h2><Card><p className="muted">Sau khi đổi mật khẩu, các phiên cũ sẽ kết thúc và bạn cần đăng nhập lại.</p>
    <form className="account-form" onSubmit={handleSubmit(async values => {
      setError('');
      try { await apiService.changePassword(values.current, values.next); logout('Đã đổi mật khẩu. Vui lòng đăng nhập lại.'); queries.clear(); nav('/login', { replace: true }); }
      catch (error) { setError(apiErrorMessage(error, 'Không thể đổi mật khẩu. Kiểm tra mật khẩu hiện tại.')); }
    })}>
      <label>Mật khẩu hiện tại<input {...register('current', { required: 'Nhập mật khẩu hiện tại.' })} type="password" autoComplete="current-password" maxLength={128} /></label>
      {errors.current && <span className="field-error">{errors.current.message}</span>}
      <label>Mật khẩu mới<input {...register('next', { ...passwordRules, validate: value => value !== getValues('current') || 'Mật khẩu mới phải khác mật khẩu hiện tại.' })} type="password" autoComplete="new-password" maxLength={128} /></label>
      {errors.next && <span className="field-error">{errors.next.message}</span>}
      <label>Nhập lại mật khẩu mới<input {...register('confirm', { required: 'Nhập lại mật khẩu mới.', validate: value => value === getValues('next') || 'Mật khẩu nhập lại không khớp.' })} type="password" autoComplete="new-password" maxLength={128} /></label>
      {errors.confirm && <span className="field-error">{errors.confirm.message}</span>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary" disabled={isSubmitting}>{isSubmitting ? 'Đang lưu…' : 'Đổi mật khẩu'}</button>
    </form>
  </Card></div>;
}
