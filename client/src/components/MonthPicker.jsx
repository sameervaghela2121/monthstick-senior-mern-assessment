import { formatMonth } from '../utils/months.js';

export default function MonthPicker({ value, options, onChange }) {
  return (
    <label className="month-picker">
      Billing month
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((month) => (
          <option key={month} value={month}>
            {formatMonth(month)}
          </option>
        ))}
      </select>
    </label>
  );
}
