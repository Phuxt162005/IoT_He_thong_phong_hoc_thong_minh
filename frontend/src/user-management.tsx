import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, apiService } from './lib/api';
import { Card, Empty, ErrorState, Loading, StatusBadge } from './components/ui';
import type { Role, User } from './types';

const roleNames: Record<Role, string> = { ADMIN: 'Admin · Quản trị', OPERATOR: 'Operator · Vận hành', VIEWER: 'Viewer · Giám sát' };
type Editor = { mode: 'create' } | { mode: 'edit' | 'reset'; user: User };
type Fields = { username: string; display_name: string; role: 'OPERATOR' | 'VIEWER'; status: User['status']; password: string; confirm: string };

function UserEditor({ editor, close, saved }: { editor: Editor; close: () => void; saved: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const user = editor.mode === 'create' ? undefined : editor.user;
  const { register, handleSubmit, getValues, formState: { isSubmitting, errors } } = useForm<Fields>({ defaultValues: { username: user?.username ?? '', display_name: user?.display_name ?? '', role: user?.role === 'OPERATOR' ? 'OPERATOR' : 'VIEWER', status: user?.status ?? 'ACTIVE' } });
  useEffect(() => { dialog.current?.showModal(); }, []);
  const title = editor.mode === 'create' ? 'Tạo tài khoản' : editor.mode === 'edit' ? 'Sửa tài khoản' : 'Đặt lại mật khẩu';
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="editor-title" onCancel={event => { event.preventDefault(); if (!isSubmitting) close(); }}>
    <div className="dialog-heading"><h2 id="editor-title">{title}</h2><button type="button" className="secondary" aria-label="Đóng" disabled={isSubmitting} onClick={close}>×</button></div>
    {user && <p className="muted">Tài khoản: <strong>{user.username}</strong></p>}
    <form className="account-form" onSubmit={handleSubmit(async values => {
      setError('');
      try {
        if (editor.mode === 'create') {
          await apiService.createUser({ username: values.username, display_name: values.display_name, role: values.role, password: values.password });
          saved('Đã tạo tài khoản. Người dùng có thể đăng nhập bằng mật khẩu vừa đặt.');
        } else if (editor.mode === 'edit') {
          await apiService.updateUser(editor.user.id, { display_name: values.display_name, role: values.role, status: values.status });
          saved('Đã cập nhật tài khoản. Thay đổi quyền hoặc trạng thái sẽ thu hồi các phiên cũ.');
        } else {
          await apiService.resetPassword(editor.user.id, values.password);
          saved('Đã đặt lại mật khẩu và thu hồi các phiên cũ của tài khoản.');
        }
      } catch (error) { setError(apiErrorMessage(error)); }
    })}>
      {editor.mode === 'create' && <>
        <label>Tên đăng nhập<input {...register('username', { required: 'Nhập tên đăng nhập.', pattern: { value: /^[A-Za-z0-9_.-]{3,64}$/, message: 'Dùng 3–64 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.' } })} autoComplete="off" maxLength={64} /></label>
        {errors.username && <span className="field-error">{errors.username.message}</span>}
      </>}
      {editor.mode !== 'reset' && <>
        <label>Họ và tên<input {...register('display_name', { required: 'Nhập họ và tên.', validate: value => Boolean(value.trim()) || 'Nhập họ và tên.', maxLength: 100 })} maxLength={100} /></label>
        {errors.display_name && <span className="field-error">{errors.display_name.message}</span>}
        <label>Vai trò<select {...register('role')}><option value="VIEWER">Viewer · Xem dữ liệu</option><option value="OPERATOR">Operator · Giám sát và điều khiển</option></select></label>
        {editor.mode === 'edit' && <label>Trạng thái<select {...register('status')}><option value="ACTIVE">Hoạt động</option><option value="DISABLED">Đã khóa</option></select></label>}
      </>}
      {editor.mode !== 'edit' && <>
        <label>{editor.mode === 'reset' ? 'Mật khẩu mới' : 'Mật khẩu'}<input {...register('password', { required: 'Nhập mật khẩu.', minLength: { value: 8, message: 'Mật khẩu cần ít nhất 8 ký tự.' }, maxLength: 128 })} type="password" autoComplete="new-password" maxLength={128} /></label>
        <span className="muted small">Từ 8 đến 128 ký tự. Mật khẩu cũ không thể xem lại.</span>
        {errors.password && <span className="field-error">{errors.password.message}</span>}
        <label>Nhập lại mật khẩu<input {...register('confirm', { required: 'Nhập lại mật khẩu.', validate: value => value === getValues('password') || 'Mật khẩu nhập lại không khớp.' })} type="password" autoComplete="new-password" maxLength={128} /></label>
        {errors.confirm && <span className="field-error">{errors.confirm.message}</span>}
      </>}
      {editor.mode === 'reset' && <p className="muted small">Người dùng sẽ cần đăng nhập lại bằng mật khẩu mới.</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={isSubmitting} onClick={close}>Hủy</button><button className="primary" disabled={isSubmitting}>{isSubmitting ? 'Đang lưu…' : title}</button></div>
    </form>
  </dialog>;
}

export function Users() {
  const queries = useQueryClient();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<User['status'] | ''>('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [message, setMessage] = useState('');
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['managed-users', page, role, status], queryFn: () => apiService.userPage({ page, page_size: 20, role: role || undefined, status: status || undefined }), retry: false });
  return <>
    <div className="page-title"><div><p className="eyebrow">SMART CLASSROOM</p><h2>Quản lý tài khoản</h2></div><button className="primary" onClick={() => { setMessage(''); setEditor({ mode: 'create' }); }}>+ Tạo tài khoản</button></div>
    <p className="muted account-description">Admin quản lý tài khoản Operator và Viewer: cấp quyền, khóa/mở khóa và đặt lại mật khẩu.</p>
    {message && <div className="notice" role="status">{message}</div>}
    <div className="filters user-filters">
      <label>Vai trò<select value={role} onChange={event => { setRole(event.target.value as Role | ''); setPage(1); }}><option value="">Tất cả</option>{Object.entries(roleNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Trạng thái<select value={status} onChange={event => { setStatus(event.target.value as User['status'] | ''); setPage(1); }}><option value="">Tất cả</option><option value="ACTIVE">Hoạt động</option><option value="DISABLED">Đã khóa</option></select></label>
    </div>
    {isLoading ? <Loading /> : isError ? <ErrorState retry={() => { void refetch(); }} /> : <Card>
      {data?.items.length ? <div className="user-table-wrap"><table className="user-table"><thead><tr><th>Họ và tên</th><th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>
        {data.items.map(user => <tr key={user.id}><td>{user.display_name}</td><td>{user.username}</td><td>{roleNames[user.role]}</td><td><StatusBadge status={user.status} /></td><td>{user.role === 'ADMIN' ? <span className="muted small">Tài khoản quản trị</span> : <div className="user-actions"><button className="secondary" onClick={() => setEditor({ mode: 'edit', user })}>Sửa</button><button className="secondary" onClick={() => setEditor({ mode: 'reset', user })}>Đặt lại mật khẩu</button></div>}</td></tr>)}
      </tbody></table></div> : <Empty text="Không có tài khoản phù hợp." />}
      <div className="pagination"><span>{data?.total ?? 0} tài khoản · Trang {page}</span><div className="user-actions"><button className="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Trước</button><button className="secondary" disabled={page * 20 >= (data?.total ?? 0)} onClick={() => setPage(page + 1)}>Sau</button></div></div>
    </Card>}
    {editor && <UserEditor key={editor.mode + (editor.mode === 'create' ? '' : editor.user.id)} editor={editor} close={() => setEditor(null)} saved={message => { setEditor(null); setMessage(message); void queries.invalidateQueries({ queryKey: ['managed-users'] }); }} />}
  </>;
}
