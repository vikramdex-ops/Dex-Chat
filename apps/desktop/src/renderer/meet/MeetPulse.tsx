// Meet on Pulse, for phones: the lens strip there holds five lenses already, so Meet is a card.
import { Icon } from '../ui.tsx';

export function MeetPulseCard({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="card interactive meet-pulse" role="button" tabIndex={0} aria-label="Meet: start or join a meeting" onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      style={{ boxShadow: 'inset 3px 0 0 var(--accent)' }}>
      <div className="eyebrow">Meet</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 40, height: 40, flex: 'none', borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}><Icon name="video" size={20} /></span>
        <span style={{ display: 'grid', gap: 2, fontSize: 14 }}>
          <b style={{ fontWeight: 600 }}>Start a meeting or join one</b>
          <span className="faint" style={{ fontSize: 12.5 }}>By its ID or link, or open your personal room</span>
        </span>
        <Icon name="chevron" size={16} className="meet-pulse-go" />
      </div>
    </div>
  );
}
