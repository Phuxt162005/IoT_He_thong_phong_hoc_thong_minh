import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Wifi, WifiOff } from 'lucide-react';
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'danger' | 'warning' | 'neutral' | 'info' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function StatusBadge({ status }: { status: string }) { const tone = ['ONLINE', 'SUCCESS', 'ACTIVE', 'ON'].includes(status) ? 'success' : ['OFFLINE', 'FAILED', 'CRITICAL', 'DISABLED'].includes(status) ? 'danger' : ['WARNING', 'PENDING', 'MAINTENANCE', 'TIMEOUT'].includes(status) ? 'warning' : 'neutral'; return <Badge tone={tone}>{status}</Badge>; }
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }
export function Empty({ text = 'Chưa có dữ liệu' }: { text?: string }) { return <div className="empty"><AlertCircle size={20} />{text}</div>; }
export function Loading() { return <div className="empty"><Loader2 className="spin" size={20} />Đang tải dữ liệu…</div>; }
export function ErrorState({ retry }: { retry?: () => void }) { return <div className="empty error"><AlertCircle size={20} />Không thể tải dữ liệu. <button onClick={retry}>Thử lại</button></div>; }
export function ConnectionBadge() { return <Badge tone="success"><Wifi size={13} /> WebSocket đã kết nối</Badge>; }
export { CheckCircle2, WifiOff };
