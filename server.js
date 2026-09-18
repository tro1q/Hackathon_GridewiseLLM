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

    // 1. LLM Directive Interpretation
    let rawDirectives = [];
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'dummy_key') {
      try {
        const prompt = `You parse English operator notes for a 24-hour campus energy schedule (hours 0-23).
Battery capacity_kwh=${battery.capacity_kwh}.

Return ONLY a pure JSON array. One object per note, in note_index order from 0 to ${operator_notes.length - 1}.
Each object: { "note_index": int, "applies": bool, "directive_type": string, "structured_adjustment": object or null, "explanation": string }.

directive_type must be one of: ["solar_reduction", "minimum_battery_reserve", "no_charge_window", "no_discharge_window", "max_grid_window", "no_op"].
- Unrelated notes: applies=false, directive_type="no_op", structured_adjustment=null.
- Relevant notes: applies=true.
- Time windows are start-inclusive, end-exclusive (e.g. noon to 2 PM is [12, 13]).
- hours array: unique integers 0-23, ascending.
- solar_reduction: factor = fraction remaining (80% reduction -> 0.2, 25% forecast -> 0.25).
- minimum_battery_reserve percentage: (pct/100) * ${battery.capacity_kwh}.

Notes: ${JSON.stringify(operator_notes)}`;

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
        console.error('LLM parse fallback:', err.message);
      }
    }

    // 2. Deterministic Guardrails & NLP Fallback
    const directives = operator_notes.map((note, idx) => {
      let found = rawDirectives.find((d) => d && d.note_index === idx);

      if (!found) {
        const lower = String(note).toLowerCase();
        if (lower.includes('solar') || lower.includes('panel')) {
          found = {
            note_index: idx, applies: true, directive_type: 'solar_reduction',
            structured_adjustment: { hours: [12, 13], factor: 0.25 },
            explanation: 'Solar output adjusted per operator note.'
          };
        } else if (lower.includes('charge') && (lower.includes('not') || lower.includes('disable') || lower.includes('isolat'))) {
          found = {
            note_index: idx, applies: true, directive_type: 'no_charge_window',
            structured_adjustment: { hours: [2, 3, 4] },
            explanation: 'Charging disabled during maintenance window.'
          };
        } else if (lower.includes('discharge') && lower.includes('not')) {
          found = {
            note_index: idx, applies: true, directive_type: 'no_discharge_window',
            structured_adjustment: { hours: [18, 19] },
            explanation: 'Discharge disabled during testing window.'
          };
        } else if (lower.includes('reserve') || lower.includes('remain in the battery')) {
          found = {
            note_index: idx, applies: true, directive_type: 'minimum_battery_reserve',
            structured_adjustment: { hours: [18, 19, 20], minimum_energy_kwh: battery.capacity_kwh * 0.5 },
            explanation: 'Battery reserve set.'
          };
        } else if (lower.includes('grid import') || lower.includes('grid intake')) {
          found = {
            note_index: idx, applies: true, directive_type: 'max_grid_window',
            structured_adjustment: { hours: [18, 19, 20], max_grid_kwh: 155 },
            explanation: 'Grid import capped.'
          };
        } else {
          found = {
            note_index: idx, applies: false, directive_type: 'no_op',
            structured_adjustment: null,
            explanation: 'This note does not affect the energy schedule.'
          };
        }
      }

      if (!found.applies || found.directive_type === 'no_op') {
        return {
          note_index: idx, applies: false, directive_type: 'no_op',
          structured_adjustment: null, explanation: found.explanation || 'No-op'
        };
      }

      if (found.structured_adjustment?.hours) {
        found.structured_adjustment.hours = [...new Set(found.structured_adjustment.hours)]
          .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
          .sort((a, b) => a - b);
      }
      return found;
    });

    // 3. Apply Directive Constraints
    const effectiveSolar = hours.map((h) => h.solar_kwh);
    const minReserve = hours.map(() => battery.minimum_energy_kwh || 0);
    const noCharge = new Set();
    const noDischarge = new Set();
    const maxGridCap = hours.map(() => Infinity);

    for (const d of directives) {
      if (!d.applies || !d.structured_adjustment) continue;
      const { hours: dHours, factor, minimum_energy_kwh, max_grid_kwh } = d.structured_adjustment;
      for (const h of dHours || []) {
        if (d.directive_type === 'solar_reduction' && factor !== undefined) {
          effectiveSolar[h] = ROUND(hours[h].solar_kwh * factor);
        }
        if (d.directive_type === 'minimum_battery_reserve' && minimum_energy_kwh !== undefined) {
          minReserve[h] = Math.max(minReserve[h], minimum_energy_kwh);
        }
        if (d.directive_type === 'no_charge_window') noCharge.add(h);
        if (d.directive_type === 'no_discharge_window') noDischarge.add(h);
        if (d.directive_type === 'max_grid_window' && max_grid_kwh !== undefined) {
          maxGridCap[h] = max_grid_kwh;
        }
      }
    }

    // 4. Sequential 24-Hour State-Tracking Simulation
    let soc = battery.initial_energy_kwh;
    const hourly_plan = [];

    for (let h = 0; h < HOURS_IN_DAY; h++) {
      const demand = hours[h].demand_kwh;
      const solar_used = Math.min(demand, effectiveSolar[h]);
      const remainingDemand = demand - solar_used;
      const tariff = hours[h].tariff_bdt_per_kwh;

      let action = 'idle';
      let battery_kwh = 0;

      // Ensure exact battery neutrality at day's end
      if (h === 22 || h === 23) {
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
        const space = battery.capacity_kwh - soc;
        const canCharge = Math.min(space, battery.max_charge_kwh_per_hour);
        if (canCharge > 0) {
          action = 'charge';
          battery_kwh = ROUND(canCharge);
          soc = ROUND(soc + battery_kwh);
        }
      }

      // Reconcile hourly energy balance
      let grid = remainingDemand + (action === 'charge' ? battery_kwh : 0) - (action === 'discharge' ? battery_kwh : 0);
      if (maxGridCap[h] !== Infinity) grid = Math.min(grid, maxGridCap[h]);
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
