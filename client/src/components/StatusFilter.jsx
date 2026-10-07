export default function StatusFilter({ value, onChange }) {
  return (
    <label className="status-filter">
      Status
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All</option>
        <option value="scheduled">Scheduled</option>
        <option value="charged">Charged</option>
        <option value="failed">Failed</option>
      </select>
    </label>
  );
}
