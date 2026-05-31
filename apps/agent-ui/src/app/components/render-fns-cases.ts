/* @checkFns user-card */

function renderUserCard(
    { name, avatar }: any,
    { isPremium }: any,
    events: { onEdit: () => void },
) {
    return (
        <div className="user-card">
            <img src={avatar} />
            <h2>{name}</h2>
            {isPremium && <span>Premium</span>}  {/* 使用 isPremium */}

            <button onClick={events.onEdit}>Edit</button>
        </div>
    );
}

export function TestView() {

    return
    <div>
    {render({
        states: {name, avatar},
        props: {isPremium},
        fn: renderUserCard,
        events: {onEdit}
    })}
    </div>
}