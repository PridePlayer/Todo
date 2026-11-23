import styles from './RangeChoice.module.css';

export type EditScope = 'this' | 'following' | 'all';

/**
 * 重复事件的三选项。
 *
 * 文案刻意不写"仅此事件/此事件及后续/所有事件"这种日历术语直译：
 * 用户在这一刻脑子里想的是"我改的是哪一个"，所以用"只有这一次"开头，
 * 并在第二行把**后果**说清楚（其他日期不变 / 之后都变 / 之前也变）。
 */
interface RangeChoiceProps {
  title: string;
  intent?: 'edit' | 'delete';
  onPick: (scope: EditScope) => void;
  onCancel: () => void;
}

export function RangeChoice({ title, intent = 'edit', onPick, onCancel }: RangeChoiceProps) {
  const verb = intent === 'delete' ? '删除' : '修改';

  const options: { scope: EditScope; label: string; hint: string }[] = [
    {
      scope: 'this',
      label: `只${verb}这一次`,
      hint: intent === 'delete' ? '这一天不再出现，其他日期不变' : '其他日期保持不变，这一次单独记住',
    },
    {
      scope: 'following',
      label: `这一次及以后都${verb}`,
      hint: '从这一天起生效，原系列在之前的最后一次结束',
    },
    {
      scope: 'all',
      label: `整个系列都${verb}`,
      hint: '包括已经过去的那些日期',
    },
  ];

  return (
    <div className={styles.overlay} role="presentation" onClick={onCancel}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="range-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">重复任务</p>
        <h2 className={styles.title} id="range-title">
          {title}
        </h2>
        <p className={styles.lead}>这是一个重复任务，{verb}范围要选一下。</p>

        <div className={styles.options}>
          {options.map((option, index) => (
            <button
              key={option.scope}
              type="button"
              className={styles.option}
              onClick={() => onPick(option.scope)}
            >
              <span className={styles.no}>{index + 1}</span>
              <span>
                <span className={styles.label}>{option.label}</span>
                <span className={styles.hint}>{option.hint}</span>
              </span>
            </button>
          ))}
        </div>

        <button type="button" className={styles.cancel} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
