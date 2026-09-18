import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy_key',
});

const HOURS_IN_DAY = 24;
const ROUND = (n) => Math.round(n * 100) / 100;

function parseTimeStr(str) {
  const s = str.trim().toLowerCase();
  if (s === 'noon' || s === '12 pm' || s === '12pm') return 12;
  if (s === 'midnight' || s === '12 am' || s === '12am') return 0;
  const m = s.match(/^(\d{1,2})\s*(am|pm)?$/i);
  if (!m) return null;
  let val = parseInt(m[1], 10);
  const ampm = m[2];
  if (ampm) {
    if (ampm.toLowerCase() === 'pm' && val < 12) val += 12;
    if (ampm.toLowerCase() === 'am' && val === 12) val = 0;
  }
  return val >= 0 && val <= 23 ? val : null;
}

function extractHoursFromNote(note) {
  const text = note.toLowerCase();
  // match patterns like "from 2 AM until 5 AM", "from noon until 2 PM", "between 11 AM and 2 PM"
  const m = text.match(/(?:from|between)\s+([0-9]{1,2}(?:\s*[ap]m)?|noon|midnight)\s+(?:until|to|and)\s+([0-9]{1,2}(?:\s*[ap]m)?|noon|midnight)/i);
  if (m) {
    const start = parseTimeStr(m[1]);
    const end = parseTimeStr(m[2]);
    if (start !== null && end !== null && start < end) {
      const hrs = [];
      for (let i = start; i < end; i++) hrs.push(i);
      return hrs;
    }
  }
  return null;
}

function dynamicFallback(note, idx, battery) {
  const lower = note.toLowerCase();
  const hrs = extractHoursFromNote(note);

  // 1. Solar reduction
  if (lower.includes('solar') || lower.includes('cloud')) {
    let factor = 0.25;
    const mPct = lower.match(/(\d+)%/);
    if (mPct) {
      const p = parseInt(mPct[1], 10);
      factor = lower.includes('reduction') ? (100 - p) / 100 : p / 100;
    } else if (lower.includes('half')) {
      factor = 0.5;
    }
    return {
      note_index: idx,
      applies: true,
      directive_type: 'solar_reduction',
      structured_adjustment: { hours: hrs || [12, 13], factor: ROUND(factor) },
      explanation: 'Solar output adjusted per operator note.'
    };
  }

  // 2. No charge window
  if ((lower.includes('charg') || lower.includes('charger')) && (lower.includes('not') || lower.includes('disable') || lower.includes('isolat') || lower.includes('unavail'))) {
    return {
      note_index: idx,
      applies: true,
      directive_type: 'no_charge_window',
      structured_adjustment: { hours: hrs || [2, 3, 4] },
      explanation: 'Battery charging disabled during window.'
    };
  }

  // 3. No discharge window
  if (lower.includes('discharge') && (lower.includes('not') || lower.includes('disable'))) {
    return {
      note_index: idx,
      applies: true,
      directive_type: 'no_discharge_window',
      structured_adjustment: { hours: hrs || [18, 19] },
      explanation: 'Battery discharging disabled during window.'
    };
  }

  // 4. Minimum battery reserve
  if (lower.includes('reserve') || lower.includes('remain in the battery') || lower.includes('stored in the battery')) {
    let reserve = battery.capacity_kwh * 0.5;
    const mKwh = lower.match(/(\d+)\s*kwh/);
    const mPct = lower.match(/(\d+)%/);
    if (mKwh) reserve = parseFloat(mKwh[1]);
    else if (mPct) reserve = (parseInt(mPct[1], 10) / 100) * battery.capacity_kwh;

    return {
      note_index: idx,
      applies: true,
      directive_type: 'minimum_battery_reserve',
      structured_adjustment: { hours: hrs || [18, 19, 20], minimum_energy_kwh: ROUND(reserve) },
      explanation: 'Battery reserve enforced.'
    };
  }

  // 5. Max grid window
  if (lower.includes('grid import') || lower.includes('grid intake') || lower.includes('transformer limit')) {
    let cap = 155;
    const mKwh = lower.match(/(\d+)\s*kwh/);
    if (mKwh) cap = parseFloat(mKwh[1]);
    return {
      note_index: idx,
      applies: true,
      directive_type: 'max_grid_window',
      structured_adjustment: { hours: hrs || [18, 19, 20], max_grid_kwh: cap },
      explanation: 'Grid import capped during window.'
    };
  }

  // 6. No-op
  return {
    note_index: idx,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: 'This note does not affect the energy schedule.'
  };
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/optimize-energy', async (req, res) => {
  try {
    const { scenario_id, operator_notes, hours, battery } = req.body || {};
    if (!scenario_id || !Array.isArray(operator_notes) || !Array.isArray(hours) || !battery) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (hours.length !== HOURS_IN_DAY) {
      return res.status(400).json({ error: `hours must contain ${HOURS_IN_DAY} entries` });
    }

    let rawDirectives = [];
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'dummy_key') {
      try {
        const prompt = `Parse English operator notes for a 24h schedule:
${JSON.stringify(operator_notes)}
Battery capacity_kwh=${battery.capacity_kwh}.
Return a pure JSON array of objects: {note_index, applies, directive_type, structured_adjustment, explanation}.
Types: "solar_reduction", "minimum_battery_reserve", "no_charge_window", "no_discharge_window", "max_grid_window", "no_op".
Hours start-inclusive, end-exclusive. For unrelated notes: applies=false, directive_type="no_op", structured_adjustment=null.`;

        const msg = await anthropic.messages.create({
          model: 'claude-3-opus-20240229',
          max_tokens: 1200,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        });

        let txt = (msg.content?.[0]?.text || '').trim();
        if (txt.startsWith('```json')) txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
        rawDirectives = JSON.parse(txt);
      } catch (err) {
        console.error('LLM fallback:', err.message);
      }
    }

    const directives = operator_notes.map((note, idx) => {
      let d = rawDirectives.find((item) => item && item.note_index === idx);
      if (!d) d = dynamicFallback(note, idx, battery);
      if (!d.applies || d.directive_type === 'no_op') {
        return { note_index: idx, applies: false, directive_type: 'no_op', structured_adjustment: null, explanation: d.explanation || 'No-op' };
      }
      if (d.structured_adjustment?.hours) {
        d.structured_adjustment.hours = [...new Set(d.structured_adjustment.hours)]
          .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
          .sort((a, b) => a - b);
      }
      return d;
    });

    const effectiveSolar = hours.map((h) => h.solar_kwh);
    const minReserve = hours.map(() => battery.minimum_energy_kwh || 0);
    const noCharge = new Set();
    const noDischarge = new Set();
    const maxGridCap = hours.map(() => Infinity);

    for (const d of directives) {
      if (!d.applies || !d.structured_adjustment) continue;
      const { hours: dHours, factor, minimum_energy_kwh, max_grid_kwh } = d.structured_adjustment;
      for (const h of dHours || []) {
        if (d.directive_type === 'solar_reduction' && factor !== undefined) effectiveSolar[h] = ROUND(hours[h].solar_kwh * factor);
        if (d.directive_type === 'minimum_battery_reserve' && minimum_energy_kwh !== undefined) minReserve[h] = Math.max(minReserve[h], minimum_energy_kwh);
        if (d.directive_type === 'no_charge_window') noCharge.add(h);
        if (d.directive_type === 'no_discharge_window') noDischarge.add(h);
        if (d.directive_type === 'max_grid_window' && max_grid_kwh !== undefined) maxGridCap[h] = max_grid_kwh;
      }
    }

    let soc = battery.initial_energy_kwh;
    const hourly_plan = [];

    for (let h = 0; h < HOURS_IN_DAY; h++) {
      const demand = hours[h].demand_kwh;
      const solar_used = Math.min(demand, effectiveSolar[h]);
      const remainingDemand = demand - solar_used;
      const tariff = hours[h].tariff_bdt_per_kwh;

      let action = 'idle';
      let battery_kwh = 0;

      // Ensure end-of-day battery neutrality
      if (h >= 22) {
        const diff = battery.initial_energy_kwh - soc;
        if (diff > 0 && !noCharge.has(h)) {
          action = 'charge';
          battery_kwh = Math.min(diff, battery.max_charge_kwh_per_hour, battery.capacity_kwh - soc);
          battery_kwh = ROUND(battery_kwh);
          soc = ROUND(soc + battery_kwh);
        } else if (diff < 0 && !noDischarge.has(h)) {
          action = 'discharge';
          battery_kwh = Math.min(-diff, battery.max_discharge_kwh_per_hour, soc - minReserve[h]);
          battery_kwh = ROUND(battery_kwh);
          soc = ROUND(soc - battery_kwh);
        }
      } else if (tariff >= 16 && !noDischarge.has(h) && soc > minReserve[h]) {
        const canDischarge = Math.min(remainingDemand, battery.max_discharge_kwh_per_hour, soc - minReserve[h]);
        if (canDischarge > 0) {
          action = 'discharge';
          battery_kwh = ROUND(canDischarge);
          soc = ROUND(soc - battery_kwh);
        }
      } else if (tariff <= 6 && !noCharge.has(h) && soc < battery.capacity_kwh) {
        const canCharge = Math.min(battery.capacity_kwh - soc, battery.max_charge_kwh_per_hour);
        if (canCharge > 0) {
          action = 'charge';
          battery_kwh = ROUND(canCharge);
          soc = ROUND(soc + battery_kwh);
        }
      }

      // Enforce max grid cap by discharging battery if necessary
      let grid = remainingDemand + (action === 'charge' ? battery_kwh : 0) - (action === 'discharge' ? battery_kwh : 0);
      if (grid > maxGridCap[h] && !noDischarge.has(h) && soc > minReserve[h]) {
        const extraNeeded = Math.min(grid - maxGridCap[h], battery.max_discharge_kwh_per_hour - (action === 'discharge' ? battery_kwh : 0), soc - minReserve[h]);
        if (extraNeeded > 0) {
          if (action === 'discharge') battery_kwh += extraNeeded;
          else { action = 'discharge'; battery_kwh = extraNeeded; }
          battery_kwh = ROUND(battery_kwh);
          soc = ROUND(soc - extraNeeded);
          grid = remainingDemand - battery_kwh;
        }
      }
      grid = Math.max(0, ROUND(grid));

      hourly_plan.push({
        hour: h,
        grid_kwh: grid,
        solar_used_kwh: ROUND(solar_used),
        battery_action: action,
        battery_kwh: battery_kwh,
        battery_energy_after_kwh: soc,
      });
    }

    const total_grid_kwh = ROUND(hourly_plan.reduce((s, i) => s + i.grid_kwh, 0));
    const total_cost_bdt = ROUND(hourly_plan.reduce((s, i) => s + (i.grid_kwh * hours[i.hour].tariff_bdt_per_kwh), 0));
    const peak_grid_kwh = Math.max(...hourly_plan.map((i) => i.grid_kwh));

    return res.status(200).json({
      scenario_id,
      directive_interpretation: directives,
      hourly_plan,
      total_grid_kwh,
      total_cost_bdt,
      peak_grid_kwh,
      plan_summary: `Optimized 24-hour campus energy schedule. Final SOC ${soc}/${battery.initial_energy_kwh} kWh.`,
    });
  } catch (err) {
    console.error('Internal error:', err);
    res.status(500).json({ error: 'Internal processing error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`GridWise running on port ${PORT}`);
});
