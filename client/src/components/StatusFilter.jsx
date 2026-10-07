const OPTIONS = [
  { value: '', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'charged', label: 'Charged' },
  { value: 'failed', label: 'Failed' },
];

export default function StatusFilter({ value, onChange }) {
  return (
    <label className="status-filter">
      Status
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
