// The emoji picker's list: each entry is "<emoji> <words to find it by>". Grouped as people
// expect, with the everyday office ones first.
export const EMOJI_GROUPS: Array<{ name: string; items: string[] }> = [
  { name: 'Office', items: [
    '👍 thumbs up yes ok agree like', '👎 thumbs down no disagree', '✅ done check tick yes complete', '❌ no cross wrong cancel', '👀 eyes looking review see',
    '🙏 thanks please pray', '🎉 party congrats celebrate tada', '👏 clap applause well done', '🙌 hooray raise hands', '💪 strong effort muscle',
    '🔥 fire hot urgent', '💯 hundred perfect full', '⚠️ warning caution alert', '📌 pin important', '📎 paperclip attach file', '📐 drawing triangle ruler design',
    '🛠️ tools fix repair', '☕ coffee tea break', '⏰ alarm time deadline', '📅 calendar date meeting', '🚀 launch rocket ship release', '⭐ star favourite',
    '❤️ heart love', '✔️ check mark', '➕ plus add', '➖ minus remove', '❓ question', '❗ exclamation important', '💡 idea bulb', '📝 note memo write',
    '📊 chart bar report', '📈 chart up growth increase', '📉 chart down decrease', '🗂️ folder files index', '📁 folder', '📄 document page', '🖨️ printer print',
    '💻 laptop computer', '🖥️ desktop computer pc', '📱 phone mobile', '☎️ telephone call', '📞 phone call', '✉️ email letter mail', '🔒 lock secure private',
    '🔑 key password', '🧾 receipt invoice', '💰 money budget', '🏗️ construction site build', '🏭 factory plant', '⚙️ gear settings engineering', '🔧 wrench spanner',
    '🔩 nut bolt', '🧰 toolbox', '📏 ruler measure', '🧪 test lab', '🗓️ schedule plan', '🕐 clock one', '⏳ hourglass waiting', '🚧 work in progress roadwork',
  ] },
  { name: 'Smileys', items: [
    '😀 grin happy smile', '😃 smile happy', '😄 laugh happy', '😁 beam grin', '😆 laughing', '😅 sweat relief phew', '🤣 rolling laughing rofl', '😂 tears joy lol',
    '🙂 slight smile', '🙃 upside down', '😉 wink', '😊 blush smile', '😇 halo innocent', '🥰 love hearts', '😍 heart eyes', '🤩 star struck', '😘 kiss',
    '😋 yum tasty', '😛 tongue', '😜 wink tongue', '🤪 zany crazy', '🤗 hug', '🤭 oops hand over mouth', '🤫 shush quiet', '🤔 thinking hmm', '🤐 zip quiet',
    '🤨 raised eyebrow sceptical', '😐 neutral', '😑 expressionless', '😶 speechless', '😏 smirk', '😒 unamused', '🙄 eye roll', '😬 grimace awkward',
    '😌 relieved', '😔 pensive sad', '😪 sleepy', '😴 sleeping', '😷 mask sick', '🤒 fever ill', '🤕 hurt', '🤧 sneeze cold', '🥵 hot', '🥶 cold freezing',
    '🥴 woozy', '😵 dizzy', '🤯 mind blown', '🤠 cowboy', '🥳 party celebrate', '😎 cool sunglasses', '🤓 nerd glasses', '🧐 monocle inspect', '😕 confused',
    '😟 worried', '🙁 frown', '😮 surprised wow', '😲 astonished', '😳 flushed', '🥺 pleading', '😦 frowning open', '😨 fearful', '😰 anxious sweat', '😥 sad relieved',
    '😢 cry tear', '😭 sob crying', '😱 scream', '😖 confounded', '😣 persevere', '😞 disappointed', '😓 downcast sweat', '😩 weary', '😫 tired', '🥱 yawn',
    '😤 triumph huff', '😡 angry', '😠 mad', '🤬 swearing', '😈 devil', '💀 skull dead', '💩 poo', '🤡 clown', '👻 ghost', '👽 alien', '🤖 robot bot',
  ] },
  { name: 'People', items: [
    '👋 wave hello bye', '🤚 raised hand', '✋ hand stop', '👌 ok perfect', '🤌 pinched fingers', '✌️ victory peace', '🤞 fingers crossed luck', '🤟 love you',
    '🤘 rock', '🤙 call me', '👈 left', '👉 right', '👆 up', '👇 down', '☝️ point up one', '✊ fist', '👊 punch', '🤛 fist bump left', '🤜 fist bump right',
    '🤝 handshake deal agreement', '✍️ writing', '💅 nails', '🧠 brain think', '👤 person user', '👥 people team', '🧑‍💻 developer coder', '👷 construction worker engineer',
    '🧑‍🔧 mechanic', '🧑‍🏫 teacher', '🧑‍💼 office worker', '🏃 running hurry', '🚶 walking', '🧘 calm meditate', '🙋 raise hand question', '🤷 shrug dunno', '🤦 facepalm',
  ] },
  { name: 'Nature and food', items: [
    '☀️ sun sunny', '🌤️ partly sunny', '⛅ cloud sun', '🌧️ rain', '⛈️ storm thunder', '❄️ snow cold', '🌈 rainbow', '🌊 wave water', '🌱 seedling grow', '🌳 tree',
    '🌸 blossom flower', '🌻 sunflower', '🍀 four leaf clover luck', '🐶 dog', '🐱 cat', '🐝 bee busy', '🦉 owl', '🐢 turtle slow', '🍕 pizza', '🍔 burger',
    '🍟 fries', '🌮 taco', '🍜 noodles', '🍛 curry rice', '🍰 cake', '🎂 birthday cake', '🍪 cookie', '🍫 chocolate', '🍎 apple', '🍌 banana', '🥭 mango', '🍵 chai tea', '🍺 beer', '🥤 drink',
  ] },
  { name: 'Things and symbols', items: [
    '🏆 trophy win', '🥇 gold first', '🎯 target goal bullseye', '🎁 gift present', '🎈 balloon', '🎊 confetti', '🔔 bell notification', '🔕 mute bell', '📣 announce megaphone',
    '🔍 search magnify', '🔗 link', '✂️ scissors cut', '🗑️ bin delete trash', '🧹 clean broom', '🚗 car', '🚕 taxi', '🚌 bus', '🚆 train', '✈️ plane travel flight',
    '🏠 home house', '🏢 office building', '🏥 hospital', '🗺️ map', '🧭 compass', '⌛ hourglass done', '⚡ lightning fast', '💧 drop water', '🔋 battery', '🔌 plug power',
    '💬 speech chat comment', '💭 thought', '🆗 ok button', '🆕 new', '🆙 up', '🔴 red circle', '🟠 orange circle', '🟡 yellow circle', '🟢 green circle', '🔵 blue circle',
    '⬆️ up arrow', '⬇️ down arrow', '➡️ right arrow', '⬅️ left arrow', '🔁 repeat', '🔄 refresh sync', '♻️ recycle', '✳️ asterisk', '🇮🇳 india flag',
  ] },
];
export const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.items.map((s) => { const sp = s.indexOf(' '); return { e: s.slice(0, sp), words: s.slice(sp + 1) }; }));
