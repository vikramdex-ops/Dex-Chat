// Nib on Pulse: your day sheet at a glance, and the wrap-up card once Nib has asked twice.
import { Icon } from '../ui.tsx';
import { NibTile } from './NibMark.tsx';
import { openTray, useNib } from './store.ts';
import { digestTimeText, wrapTimeText } from './words.ts';

export function NibPulseCard() {
  const me = useNib((s) => s.me);
  if (!me || !me.enabled) return null;
  const asking = !!me.nudge && me.nudge.level >= 2 && me.day.state === 'open';
  const onLeave = !!me.leave && me.leave.from <= me.date && me.leave.to >= me.date;
  const open = me.items.filter((x) => x.status !== 'done').length;
  const line = onLeave ? 'On leave today. Nothing to fill in.'
    : me.exempt ? `The register comes at ${digestTimeText(me)}.`
      : !me.workday ? 'Not a workday.'
        : me.day.state === 'sent' ? 'Sent to your leads.'
          : me.day.state === 'nothing' ? 'Nothing today.'
            : asking ? `Pens down at ${wrapTimeText(me)}. Thirty seconds to send it.`
              : !me.items.length ? 'Blank so far. Tell Nib as work comes in.'
                : open === 1 ? `One thing going. Wrap-up at ${wrapTimeText(me)}.` : `${open} things going. Wrap-up at ${wrapTimeText(me)}.`;
  return (
    <div className={`card interactive nib-pulse${asking ? ' asking' : ''}`} role="button" tabIndex={0} onClick={() => openTray(asking ? { v: 'wrap' } : { v: 'home' })}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTray(asking ? { v: 'wrap' } : { v: 'home' }); } }}>
      <div className="eyebrow">Nib · Day sheet</div>
      <div className="nib-pulse-row">
        <span className="stat">{me.items.length}</span>
        <NibTile size={36} ink={asking ? 'needs' : 'none'} />
      </div>
      <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{line}</p>
      {asking && <span className="btn primary sm nib-pulse-go"><Icon name="daysheet" size={14} />Check and send</span>}
    </div>
  );
}
