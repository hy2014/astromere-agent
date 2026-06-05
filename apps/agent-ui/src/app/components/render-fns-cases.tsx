/* @checkFns user-card */
import {render} from "../../core/dep";

function renderUserCard(
    { name, avatar }: any,
    { isPremium }: any,
    { onEdit }: { onEdit: () => void },
) {
    return (
        <div className="user-card">
            <img src={avatar} />
            <h2>{name}</h2>
            {isPremium && <span>Premium</span>}  {/* 使用 isPremium */}

            <button onClick={onEdit}>Edit</button>
        </div>
    );
}

export function TestView() {
    const name = "Test";
    const avatar = "";
    const isPremium = false;
    const onEdit = (): void => {};

    return (
    <div>
    {render({
        state: {name, avatar},
        props: {isPremium},
        fn: renderUserCard,
        events: {onEdit}
    })}
    </div>
    );
}