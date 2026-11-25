import type { WidgetHabit, WidgetSummary, WidgetTask } from '@grid/core';
import { FlexWidget, TextWidget } from 'react-native-android-widget';

/**
 * 4×4 桌面小组件的外观（docs/11 §2）。
 *
 * 这个文件里**不允许**出现任何数据获取、存储、业务判断：
 *   · 它在 headless JS 里被调用，没有 React 上下文（useState/useEffect 会直接崩）
 *   · 它是纯渲染，传入什么画什么 —— 所以同一份 summary 在 App 的预览里和桌面上
 *     长得完全一样，调试时不需要装 APK 也能看
 *
 * 排版是"待办 3 行 + 打卡 3 行"，两块面积对等。早期版本把打卡压成一行四个
 * 无标签圆圈，省下来的空间全变成了理解成本 —— 用户不知道哪个圆是哪个习惯，
 * 点了没到目标还以为点击坏了。
 */

const COLORS = {
  bg: '#ffffff',
  line: '#f4f4f5',
  text: '#18181b',
  muted: '#71717a',
  faint: '#a1a1aa',
  accent: '#002fa7',
  danger: '#c0311e',
  warn: '#a16207',
  border: '#d4d4d8',
} as const;

/** 象限色条：1=重要且紧急 2=重要 3=紧急 4=都不 */
const QUADRANT_COLOR: Record<number, `#${string}`> = {
  1: COLORS.danger,
  2: COLORS.accent,
  3: COLORS.warn,
  4: COLORS.border,
};

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** `2026-11-25` → `11 月 25 日 · 周三` */
function friendlyDate(today: string): string {
  const parts = today.split('-').map(Number);
  const [year, month, day] = parts;
  if (!year || !month || !day) return today;
  const date = new Date(year, month - 1, day);
  return `${month} 月 ${day} 日 · 周${WEEK[date.getDay()]}`;
}

export interface GridWidgetProps {
  summary: WidgetSummary | null;
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: COLORS.bg,
        borderRadius: 18,
        padding: 16,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <TextWidget text={title} style={{ fontSize: 15, color: COLORS.accent, fontWeight: 'bold' }} />
      <TextWidget text={hint} style={{ fontSize: 12, color: COLORS.muted, marginTop: 6 }} />
    </FlexWidget>
  );
}

/**
 * 待办行。
 *
 * 标题外面要套一层 `flex: 1` 的 FlexWidget：TextWidget 自己不带权重，
 * 直接放进 row 里会用「自然宽度」，长标题会把右侧的"逾期"挤出去。
 */
function TaskRow({ task }: { task: WidgetTask }) {
  return (
    <FlexWidget
      clickAction="TOGGLE_TASK"
      clickActionData={{ taskId: task.id }}
      accessibilityLabel={`完成待办 ${task.title}`}
      style={{
        flexDirection: 'row',
        width: 'match_parent',
        alignItems: 'center',
        flexGap: 7,
        height: 31,
      }}
    >
      <FlexWidget
        style={{
          width: 3,
          height: 14,
          borderRadius: 2,
          backgroundColor: QUADRANT_COLOR[task.quadrant] ?? COLORS.border,
        }}
      />
      <FlexWidget
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          borderWidth: 1.5,
          borderColor: COLORS.border,
          backgroundColor: COLORS.bg,
        }}
      />
      <FlexWidget style={{ flex: 1 }}>
        <TextWidget
          text={task.title}
          style={{ width: 'match_parent', fontSize: 12, color: COLORS.text }}
          truncate="END"
          maxLines={1}
        />
      </FlexWidget>
      {task.overdue ? (
        <TextWidget text="逾期" style={{ fontSize: 10, color: COLORS.danger }} maxLines={1} />
      ) : null}
    </FlexWidget>
  );
}

/**
 * 打卡行。语法与待办行一致：左边一个圆、中间名字、右边进度。
 *
 * 三种状态靠圆的填充表达（不靠打勾）：实心 = 已达标、蓝边 = 点过但没到目标、
 * 灰边 = 还没动。计数型"喝到 3/8"必须能看出点了有反应，否则用户会以为点击失灵。
 */
function HabitRow({ habit }: { habit: WidgetHabit }) {
  const done = habit.doneToday;
  const touched = !done && habit.value > 0;

  return (
    <FlexWidget
      clickAction="CHECK_HABIT"
      clickActionData={{ habitId: habit.id }}
      accessibilityLabel={`打卡 ${habit.name}，今天 ${habit.value}/${habit.target}`}
      style={{
        flexDirection: 'row',
        width: 'match_parent',
        alignItems: 'center',
        flexGap: 7,
        height: 27,
      }}
    >
      <FlexWidget
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          borderWidth: done ? 0 : 1.5,
          borderColor: touched ? COLORS.accent : COLORS.border,
          backgroundColor: done ? COLORS.accent : COLORS.bg,
        }}
      />
      <FlexWidget style={{ flex: 1 }}>
        <TextWidget
          text={habit.name}
          style={{ width: 'match_parent', fontSize: 12, color: done ? COLORS.muted : COLORS.text }}
          truncate="END"
          maxLines={1}
        />
      </FlexWidget>
      <TextWidget
        text={`${Math.round(habit.value)}/${habit.target}`}
        style={{ fontSize: 10, color: done ? COLORS.accent : COLORS.muted }}
        maxLines={1}
      />
    </FlexWidget>
  );
}

export function GridWidget({ summary }: GridWidgetProps) {
  if (!summary) {
    return <EmptyState title="GRID" hint="打开 App 登录后这里会显示今天的安排" />;
  }

  // 只画 3 条：第 4 条是留给"勾掉一条后立刻补位"的，不占桌面位置
  const tasks = summary.tasks.slice(0, 3);
  const habits = summary.habits;
  const hiddenHabits = Math.max(0, summary.habitTotal - habits.length);

  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: COLORS.bg,
        borderRadius: 18,
        paddingHorizontal: 13,
        paddingTop: 11,
        paddingBottom: 10,
        flexDirection: 'column',
      }}
    >
      {/* 头部 */}
      <FlexWidget
        style={{
          flexDirection: 'row',
          width: 'match_parent',
          justifyContent: 'space-between',
          alignItems: 'center',
          height: 14,
        }}
      >
        <TextWidget
          text={`今天 · ${friendlyDate(summary.today)}`}
          style={{ fontSize: 10, color: COLORS.muted }}
          maxLines={1}
        />
        <TextWidget
          text={summary.openCount === 0 ? '全部完成' : `未完成 ${summary.openCount}`}
          style={{ fontSize: 10, color: COLORS.accent, fontWeight: 'bold' }}
          maxLines={1}
        />
      </FlexWidget>

      <FlexWidget style={{ height: 1, width: 'match_parent', backgroundColor: COLORS.line, marginTop: 6 }} />

      {/* 待办：flex 吸收剩余空间，让打卡区始终贴着底部 */}
      <FlexWidget style={{ flex: 1, flexDirection: 'column', width: 'match_parent', paddingTop: 5 }}>
        {tasks.length === 0 ? (
          <FlexWidget style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <TextWidget text="今天没有待办" style={{ fontSize: 12, color: COLORS.faint }} />
          </FlexWidget>
        ) : (
          tasks.map((task) => <TaskRow key={task.id} task={task} />)
        )}
      </FlexWidget>

      <FlexWidget style={{ height: 1, width: 'match_parent', backgroundColor: COLORS.line, marginBottom: 7 }} />

      {/* 打卡标题行 */}
      <FlexWidget
        style={{
          flexDirection: 'row',
          width: 'match_parent',
          justifyContent: 'space-between',
          alignItems: 'center',
          height: 13,
        }}
      >
        <TextWidget text="打卡" style={{ fontSize: 10, color: COLORS.muted }} />
        <TextWidget
          text={summary.maxStreak > 0 ? `连续 ${summary.maxStreak} 天` : '今天还没打'}
          style={{ fontSize: 10, color: summary.maxStreak > 0 ? COLORS.accent : COLORS.faint }}
          maxLines={1}
        />
      </FlexWidget>

      {habits.length === 0 ? (
        <FlexWidget style={{ height: 27, justifyContent: 'center' }}>
          <TextWidget text="今天没有打卡项" style={{ fontSize: 11, color: COLORS.faint }} />
        </FlexWidget>
      ) : (
        habits.map((habit) => <HabitRow key={habit.id} habit={habit} />)
      )}

      {hiddenHabits > 0 ? (
        <TextWidget
          text={`还有 ${hiddenHabits} 个打卡项，打开 App 查看`}
          style={{ fontSize: 10, color: COLORS.faint, marginTop: 2 }}
          maxLines={1}
        />
      ) : null}
    </FlexWidget>
  );
}

/** 令牌过期 / 读不到数据时用：不要显示半截假数据，那比空白更难判断 */
export function GridWidgetSignedOut() {
  return <EmptyState title="GRID" hint="登录已过期，打开 App 重新授权" />;
}
