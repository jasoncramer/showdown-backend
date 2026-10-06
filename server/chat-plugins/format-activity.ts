/**
 * Format activity - how busy each format is, for the format picker.
 *
 * `/cmd formatactivity [format]` answers with
 * `|queryresponse|formatactivity|JSON`, where JSON is
 * `{ battles, searching }` for the given format, or a table of those keyed
 * by format id when no format is given. Hidden battles are counted too -
 * only totals are sent, never rooms or names.
 */

interface FormatActivity {
	/** Battles in progress - a best-of series counts once, not once per game. */
	battles: number;
	/** Players currently in the ladder search queue. */
	searching: number;
}

function getFormatActivity() {
	const activity = new Map<string, FormatActivity>();
	// A challenge's format carries its custom rules ("gen9ou@@@Best of = 3") -
	// count it under the format itself.
	const entry = (format: string) => {
		const formatid = toID(format.split('@@@')[0]);
		let found = activity.get(formatid);
		if (!found) {
			found = { battles: 0, searching: 0 };
			activity.set(formatid, found);
		}
		return found;
	};

	for (const room of Rooms.rooms.values()) {
		if (room.type !== 'battle') continue;
		if (room.bestOf) {
			// The series' own room - it spans the gaps between its games.
			if (!room.bestOf.ended) entry(room.format).battles++;
		} else if (room.battle && !room.battle.ended && !room.parent?.bestOf) {
			// A standalone battle - one game of a series is counted above.
			entry(room.format).battles++;
		}
	}
	for (const [formatid, formatTable] of Ladders.searches) {
		if (formatTable.searches.size) entry(formatid).searching += formatTable.searches.size;
	}
	return activity;
}

export const crqHandlers: { [k: string]: Chat.CRQHandler } = {
	formatactivity(target) {
		const activity = getFormatActivity();
		const formatid = toID(target);
		if (formatid) return activity.get(formatid) ?? { battles: 0, searching: 0 };
		return Object.fromEntries(activity);
	},
};
