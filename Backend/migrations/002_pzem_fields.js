// PZEM-004T values beyond V/A/W. Nullable: NULL means "not reported", never 0.

module.exports = {
  version: 2,
  name: "pzem_fields",
  async up(db) {
    for (const table of ["readings", "readings_log"]) {
      for (const col of ["apparent_power", "power_factor", "frequency", "energy_kwh"]) {
        await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} NUMERIC;`);
      }
    }
  },
};
