/**
 * Format data - what a team can be in a format, for the team builder, from
 * the same validator that checks teams when a battle starts.
 *
 * `/cmd formatdata FORMAT` answers with `|queryresponse|formatdata|JSON`:
 * the format's team rules, and the species, items, abilities and moves its
 * teams can use (see FormatData).
 *
 * `/cmd formatlearnset FORMAT, SPECIES` answers with
 * `|queryresponse|formatlearnset|JSON`: the ids of the moves that species
 * can learn in the format.
 *
 * `/cmd validateteam FORMAT|PACKEDTEAM` answers with
 * `|queryresponse|validateteam|JSON`: `{ format, team, problems }`, where
 * problems is empty for a legal team.
 *
 * A reply repeats what it answers (the format, species or team), so a
 * client with several queries out can tell the replies apart. A format
 * that doesn't exist, or has no teams to build, answers null.
 */

import type { TeamValidator as Validator } from '../../sim/team-validator';

// Battle-only forms a team can still start as: Showdown accepts these
// holding their Rusted Sword/Shield.
const BUILDABLE_BATTLE_FORMS = new Set(['zaciancrowned', 'zamazentacrowned']);

interface FormatRules {
	/** Champions' Stat Points in place of EVs: 1 point is 1 stat point. */
	statPoints: boolean;
	/** Total EVs (or Stat Points) a Pokémon can have; null for no limit. */
	evLimit: number | null;
	/** EVs (or Stat Points) a single stat can have. */
	maxEvPerStat: number;
	/** Every Pokémon's IVs must be 31. */
	fixedIvs: boolean;
	/** Every Pokémon plays at this level, whatever its set says; null if it's up to the set. */
	fixedLevel: number | null;
	/** Highest level a set can be. */
	maxLevel: number;
	tera: boolean;
	/** Some held item is a Mega Stone. */
	mega: boolean;
}

interface FormatData {
	format: ID;
	rules: FormatRules;
	/** Species a team can start as, with the abilities each can have. */
	species: { name: string, abilities: string[] }[];
	items: { name: string, desc: string }[];
	/** Every ability a species above can have (and its Mega, if it has one). */
	abilities: { [name: string]: string };
	moves: {
		id: ID,
		name: string,
		type: string,
		category: string,
		basePower: number,
		accuracy: number | true,
		pp: number,
		noPPBoosts: boolean,
		priority: number,
		target: string,
		desc: string,
		contact: boolean,
		status: string | null,
		/** Raises one of the user's own stats every time. */
		raisesUserStats: boolean,
	}[];
}

function getValidator(formatName: string): Validator | null {
	const format = Dex.formats.get(formatName);
	if (!format.exists || format.effectType !== 'Format' || format.team) return null;
	return TeamValidator.get(format);
}

const formatDataCache = new Map<ID, FormatData>();

function getFormatData(validator: Validator): FormatData {
	const cached = formatDataCache.get(validator.format.id);
	if (cached) return cached;

	const { dex, ruleTable, format } = validator;
	// Each check needs a set to name in its message - nothing here reads it.
	const set = (species: string) => ({ name: species, species } as PokemonSet);
	const describe = (thing: Item | Ability | Move) => {
		const text = dex.text.get(thing) as ResolvedItemText | ResolvedAbilityText | ResolvedMoveText;
		return text.shortDesc || text.desc || '';
	};
	const statPoints = dex.currentMod.startsWith('champions');

	const items = dex.items.all()
		.filter(item => item.id && !validator.checkItem(set(''), item, {}))
		.map(item => ({ name: item.name, desc: describe(item) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const megaStones = new Set(dex.items.all()
		.filter(item => item.megaStone && items.some(({ name }) => name === item.name))
		.flatMap(item => Object.values(item.megaStone!)));

	const abilities: { [name: string]: string } = {};
	const species: FormatData['species'] = [];
	for (const entry of dex.species.all()) {
		if (entry.battleOnly && !BUILDABLE_BATTLE_FORMS.has(entry.id)) continue;
		if (validator.checkSpecies(set(entry.name), entry, entry, {})) continue;
		const own = [...new Set(Object.values(entry.abilities))].filter(name => {
			const ability = dex.abilities.get(name);
			return ability.exists && !validator.checkAbility(set(entry.name), ability, {});
		});
		species.push({ name: entry.name, abilities: own });
		const forms = [entry, ...(entry.otherFormes ?? []).map(name => dex.species.get(name))];
		for (const form of forms) {
			if (form !== entry && !megaStones.has(form.name)) continue;
			for (const name of Object.values(form.abilities)) {
				const ability = dex.abilities.get(name);
				if (ability.exists) abilities[ability.name] = describe(ability);
			}
		}
	}
	species.sort((a, b) => a.name.localeCompare(b.name));

	const moves = dex.moves.all()
		.filter(move => !move.isZ && !move.isMax && !validator.checkMove(set(''), move, {}))
		.map(move => ({
			id: move.id,
			name: move.name,
			type: move.type,
			category: move.category,
			basePower: move.basePower,
			accuracy: move.accuracy,
			pp: move.pp,
			noPPBoosts: !!move.noPPBoosts,
			priority: move.priority,
			target: move.target,
			desc: describe(move),
			contact: !!move.flags['contact'],
			status: move.status ?? null,
			raisesUserStats: Object.values(
				(move.target === 'self' ? move.boosts : move.self?.boosts) ?? {}
			).some(stages => stages > 0),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const data: FormatData = {
		format: format.id,
		rules: {
			statPoints,
			evLimit: ruleTable.evLimit,
			maxEvPerStat: statPoints ? 32 : 252,
			fixedIvs: statPoints,
			fixedLevel: ruleTable.adjustLevel,
			maxLevel: ruleTable.maxLevel,
			tera: dex.gen === 9 && !statPoints && !ruleTable.has('terastalclause'),
			mega: megaStones.size > 0,
		},
		species,
		items,
		abilities,
		moves,
	};
	formatDataCache.set(format.id, data);
	return data;
}

function getLearnset(validator: Validator, speciesName: string): ID[] | null {
	const { dex } = validator;
	const species = dex.species.get(speciesName);
	if (!species.exists) return null;
	const set = { name: species.name, species: species.name } as PokemonSet;
	return [...dex.species.getMovePool(species.id)].filter(id => {
		const move = dex.moves.get(id);
		return move.exists && !validator.checkMove(set, move, {}) &&
			!validator.checkCanLearn(move, species, validator.allSources(species), set);
	}).sort();
}

export const crqHandlers: { [k: string]: Chat.CRQHandler } = {
	formatdata(target) {
		const validator = getValidator(target);
		return validator ? getFormatData(validator) : null;
	},
	formatlearnset(target) {
		const [format, species] = target.split(',').map(part => part.trim());
		const validator = getValidator(format);
		const moves = validator && species ? getLearnset(validator, species) : null;
		return moves && { format: validator!.format.id, species, moves };
	},
	async validateteam(target) {
		const [format, ...rest] = target.split('|');
		const team = rest.join('|');
		const validator = getValidator(format);
		if (!validator) return null;
		const result: string = await TeamValidatorAsync.get(validator.format.id).validateTeam(team);
		return {
			format: validator.format.id,
			team,
			problems: result.startsWith('1') ? [] : result.slice(1).split('\n').filter(Boolean),
		};
	},
};
